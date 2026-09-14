import ts = require('typescript');

interface FlatConfigArray {
  closing: number;
  separatorAt?: number;
}

/** Locate a direct default-exported array without evaluating repository code. */
export function locateEslintFlatConfig(
  source: string,
): FlatConfigArray | undefined {
  const file = ts.createSourceFile(
    'eslint.config.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const diagnostics = (
    file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (diagnostics.length) return undefined;
  const exports = file.statements.filter(ts.isExportAssignment);
  if (exports.length !== 1 || exports[0].isExportEquals) return undefined;
  let expression = exports[0].expression;
  while (ts.isParenthesizedExpression(expression))
    expression = expression.expression;
  if (!ts.isArrayLiteralExpression(expression)) return undefined;
  const last = expression.elements.at(-1);
  return {
    closing: expression.end - 1,
    // Insert before trailing comments, never after a line comment that could
    // swallow the comma. The parser knows whether an actual comma is present.
    ...(last && !expression.elements.hasTrailingComma
      ? { separatorAt: last.end }
      : {}),
  };
}

/** Preserve all existing bytes; insert only a separator and the managed block. */
export function appendEslintFlatConfig(
  source: string,
  block: string,
): string | undefined {
  const array = locateEslintFlatConfig(source);
  if (!array) return undefined;
  let before = source.slice(0, array.closing);
  if (array.separatorAt !== undefined)
    before = `${before.slice(0, array.separatorAt)},${before.slice(array.separatorAt)}`;
  return `${before}${before.endsWith('\n') ? '' : '\n'}${block}\n${source.slice(array.closing)}`;
}
