import ts = require('typescript');

interface FlatConfigArray {
  opening: number;
  closing: number;
  separatorAt?: number;
  wrapped: boolean;
}

/** Locate a default array or the canonical policy wrapper without evaluating code. */
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
  const exports = file.statements.filter(ts.isExportAssignment);
  if (exports.length !== 1 || exports[0].isExportEquals) return undefined;
  const assignment = exports[0];
  // Older supported TypeScript parsers do not recognize newer JavaScript import
  // attributes. Only errors touching the export prevent locating its array;
  // all surrounding repository-owned bytes remain untouched.
  if (
    diagnostics.some(
      (diagnostic) =>
        diagnostic.start === undefined ||
        (diagnostic.start <= assignment.end &&
          diagnostic.start + (diagnostic.length ?? 0) >=
            assignment.getStart(file)),
    )
  )
    return undefined;
  let expression = exports[0].expression;
  while (ts.isParenthesizedExpression(expression))
    expression = expression.expression;
  const wrapped =
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === 'megamonoPlugin' &&
    expression.expression.name.text === 'withBoundaryAllowances' &&
    expression.arguments.length === 2 &&
    ts.isIdentifier(expression.arguments[0]) &&
    expression.arguments[0].text === 'megamonoConfig';
  if (wrapped && ts.isCallExpression(expression)) {
    expression = expression.arguments[1];
    while (ts.isParenthesizedExpression(expression))
      expression = expression.expression;
  }
  if (!ts.isArrayLiteralExpression(expression)) return undefined;
  const last = expression.elements.at(-1);
  return {
    wrapped,
    opening: expression.getStart(file),
    closing: expression.end - 1,
    // Insert before trailing comments, never after a line comment that could
    // swallow the comma. The parser knows whether an actual comma is present.
    ...(last && !expression.elements.hasTrailingComma
      ? { separatorAt: last.end }
      : {}),
  };
}

/** Consumer entries follow defaults and therefore retain their rule severities. */
export function prependEslintFlatConfig(
  source: string,
  block: string,
): string | undefined {
  const array = locateEslintFlatConfig(source);
  if (!array) return undefined;
  return `${source.slice(0, array.opening + 1)}\n${block}\n${source.slice(array.opening + 1)}`;
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

/** Preserve the array and repository bytes; never nest or guess a config factory. */
export function wrapEslintBoundaryAllowances(
  source: string,
): string | undefined {
  const array = locateEslintFlatConfig(source);
  if (!array) return undefined;
  if (array.wrapped) return source;
  return `${source.slice(0, array.opening)}megamonoPlugin.withBoundaryAllowances(megamonoConfig, ${source.slice(array.opening, array.closing + 1)})${source.slice(array.closing + 1)}`;
}

/** Recognize the canonical imports and live config call, rather than comments/text. */
export function hasBoundaryAllowanceEslintActivation(source: string): boolean {
  if (!locateEslintFlatConfig(source)?.wrapped) return false;
  const file = ts.createSourceFile(
    'eslint.config.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const imports = new Map(
    file.statements
      .filter(ts.isImportDeclaration)
      .flatMap((statement) =>
        statement.importClause?.name &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? [
              [
                statement.importClause.name.text,
                statement.moduleSpecifier.text,
              ] as const,
            ]
          : [],
      ),
  );
  if (
    imports.get('megamonoPlugin') !== '@megamono/plugin/eslint' ||
    imports.get('megamonoConfig') !== './megamono.json'
  )
    return false;
  const assignment = file.statements.find(ts.isExportAssignment);
  if (!assignment) return false;
  let expression = assignment.expression;
  while (ts.isParenthesizedExpression(expression))
    expression = expression.expression;
  if (!ts.isCallExpression(expression)) return false;
  expression = expression.arguments[1];
  while (ts.isParenthesizedExpression(expression))
    expression = expression.expression;
  if (!ts.isArrayLiteralExpression(expression)) return false;
  return expression.elements.some(
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'megamonoPlugin' &&
      node.expression.name.text === 'createConfig' &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === 'megamonoConfig',
  );
}
