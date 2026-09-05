import * as ts from 'typescript';

/** Static Nest route declarations only; dynamic declarations require review. */
export function nestRoutes(content: string, file: string) {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = new Map<string, string>();
  for (const node of source.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== '@nestjs/common'
    )
      continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements)
        imports.set(item.name.text, item.propertyName?.text ?? item.name.text);
  }
  const decorators = (node: ts.Node) =>
    ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  const call = (node: ts.Decorator) =>
    ts.isCallExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression)
      ? {
          name: imports.get(node.expression.expression.text),
          args: node.expression.arguments,
        }
      : undefined;
  const paths = (node?: ts.Expression): string[] | undefined => {
    if (!node) return [''];
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (
      ts.isArrayLiteralExpression(node) &&
      node.elements.every(ts.isStringLiteralLike)
    )
      return node.elements.map((item) => (item as ts.StringLiteral).text);
    return undefined;
  };
  const routes: { method: string; path: string }[] = [];
  let unresolved = false;
  for (const node of source.statements) {
    if (!ts.isClassDeclaration(node)) continue;
    const controller = decorators(node)
      .map(call)
      .find((item) => item?.name === 'Controller');
    if (!controller) continue;
    const prefixes = paths(controller.args[0]);
    for (const member of node.members) {
      for (const decorator of decorators(member).map(call)) {
        if (
          !decorator?.name ||
          ![
            'Get',
            'Post',
            'Put',
            'Patch',
            'Delete',
            'Options',
            'Head',
            'All',
          ].includes(decorator.name)
        )
          continue;
        const suffixes = paths(decorator.args[0]);
        if (!prefixes || !suffixes) {
          unresolved = true;
          continue;
        }
        for (const prefix of prefixes)
          for (const suffix of suffixes)
            routes.push({
              method: decorator.name.toUpperCase(),
              path:
                '/' +
                [prefix, suffix].join('/').split('/').filter(Boolean).join('/'),
            });
      }
    }
  }
  return { routes, unresolved };
}
