import * as ts from 'typescript';

export interface RuntimeImport {
  readonly specifier?: string;
  readonly start: number;
  readonly serverOnly: boolean;
  readonly mode: 'import' | 'require';
}

const dataExports = new Set([
  'getServerSideProps',
  'getStaticProps',
  'getStaticPaths',
]);

export function nextPagesEdgeRuntime(filename: string, text: string): boolean {
  const unwrap = (node: ts.Expression): ts.Expression => {
    while (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isTypeAssertionExpression(node)
    )
      node = node.expression;
    return node;
  };
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  return source.statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      ) &&
      statement.declarationList.declarations.some((declaration) => {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
          return false;
        const value = unwrap(declaration.initializer);
        const edge = (expression: ts.Expression) => {
          const node = unwrap(expression);
          return (
            ts.isStringLiteral(node) &&
            ['edge', 'experimental-edge'].includes(node.text)
          );
        };
        if (declaration.name.text === 'runtime') return edge(value);
        return (
          declaration.name.text === 'config' &&
          ts.isObjectLiteralExpression(value) &&
          value.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              (ts.isIdentifier(property.name) ||
                ts.isStringLiteral(property.name)) &&
              property.name.text === 'runtime' &&
              edge(property.initializer),
          )
        );
      }),
  );
}

/** Imports erased by TypeScript or Next's Pages Router data-function transform. */
export function nextPagesImports(
  filename: string,
  text: string,
  page: boolean,
  verbatimModuleSyntax = false,
): readonly RuntimeImport[] {
  const options: ts.CompilerOptions = {
    allowJs: true,
    noResolve: true,
    noLib: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options);
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  host.getSourceFile = (path) => (path === filename ? source : undefined);
  const program = ts.createProgram([filename], options, host);
  const checker = program.getTypeChecker();
  // Binding is required: matching names would confuse shadowed identifiers.
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  const collect = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : ts.isExportSpecifier(node.parent) && !node.parent.propertyName
          ? checker.getExportSpecifierLocalTargetSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
      if (symbol) {
        const entries = references.get(symbol) ?? [];
        entries.push(node);
        references.set(symbol, entries);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const dataRoots = new Set<ts.Node>();
  if (page) {
    for (const statement of source.statements) {
      if (
        !exported(statement) ||
        (ts.canHaveModifiers(statement) &&
          ts
            .getModifiers(statement)
            ?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
            ))
      )
        continue;
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name &&
        dataExports.has(statement.name.text)
      )
        dataRoots.add(statement);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            dataExports.has(declaration.name.text)
          )
            dataRoots.add(declaration);
        }
      }
    }
  }
  const typePosition = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isTypeNode(parent)) {
        // A class's `extends Base` expression runs at runtime.
        if (
          ts.isExpressionWithTypeArguments(parent) &&
          ts.isHeritageClause(parent.parent) &&
          parent.parent.token === ts.SyntaxKind.ExtendsKeyword &&
          ts.isClassLike(parent.parent.parent)
        )
          continue;
        return true;
      }
      if (ts.isExpression(parent) || ts.isStatement(parent)) break;
    }
    return false;
  };
  const serverReference = (
    node: ts.Node,
    seen = new Set<ts.Symbol>(),
  ): boolean => {
    for (
      let parent: ts.Node | undefined = node;
      parent && parent !== source;
      parent = parent.parent
    ) {
      if (dataRoots.has(parent)) return true;
      // Non-exported helpers used exclusively by a data function disappear too.
      if (
        (ts.isFunctionDeclaration(parent) ||
          ts.isVariableDeclaration(parent)) &&
        parent.name &&
        ts.isIdentifier(parent.name)
      ) {
        const statement = ts.isVariableDeclaration(parent)
          ? parent.parent.parent
          : parent;
        if (statement.parent !== source || exported(statement)) continue;
        const symbol = checker.getSymbolAtLocation(parent.name);
        if (!symbol || seen.has(symbol)) return false;
        const uses = (references.get(symbol) ?? []).filter(
          (ref) => ref !== parent.name && !typePosition(ref),
        );
        const next = new Set(seen).add(symbol);
        return (
          uses.length > 0 && uses.every((ref) => serverReference(ref, next))
        );
      }
    }
    return false;
  };
  const bindingServerOnly = (name: ts.Identifier) => {
    const symbol = checker.getSymbolAtLocation(name);
    const uses = symbol
      ? (references.get(symbol) ?? []).filter(
          (ref) => ref !== name && !typePosition(ref),
        )
      : [];
    // Unused value imports may still have side effects. Only explicit type
    // imports, or bindings proven to feed data functions, are excluded.
    return uses.length > 0 && uses.every((ref) => serverReference(ref));
  };
  const result: RuntimeImport[] = [];
  const literal = (
    node: ts.Node | undefined,
    seen = new Set<ts.Symbol>(),
  ): string | undefined => {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = literal(node.left, seen),
        right = literal(node.right, seen);
      return left !== undefined && right !== undefined
        ? left + right
        : undefined;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration;
      if (
        symbol &&
        !seen.has(symbol) &&
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        declaration.parent.flags & ts.NodeFlags.Const
      )
        return literal(declaration.initializer, new Set(seen).add(symbol));
    }
    return undefined;
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) return;
      const bindings: ts.Identifier[] = [];
      if (clause?.name) bindings.push(clause.name);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings))
          bindings.push(clause.namedBindings.name);
        else
          for (const element of clause.namedBindings.elements)
            if (!element.isTypeOnly) bindings.push(element.name);
      }
      if (
        !verbatimModuleSyntax &&
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        !bindings.length
      )
        return;
      result.push({
        specifier: node.moduleSpecifier.text,
        start: node.getStart(source),
        mode: 'import',
        serverOnly:
          page && bindings.length > 0 && bindings.every(bindingServerOnly),
      });
      return;
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (
        node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          !verbatimModuleSyntax &&
          node.exportClause.elements.every((e) => e.isTypeOnly))
      )
        return;
      result.push({
        specifier: node.moduleSpecifier.text,
        start: node.getStart(source),
        mode: 'import',
        serverOnly:
          page &&
          !!node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((element) =>
            dataExports.has(element.name.text),
          ),
      });
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      result.push({
        specifier: node.moduleReference.expression.text,
        start: node.getStart(source),
        mode: 'require',
        serverOnly: page && bindingServerOnly(node.name),
      });
      return;
    }
    if (ts.isCallExpression(node)) {
      const dynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall =
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        !checker.getSymbolAtLocation(node.expression)?.declarations?.length;
      if (dynamicImport || requireCall)
        result.push({
          specifier: literal(node.arguments[0]),
          start: node.getStart(source),
          mode: dynamicImport ? 'import' : 'require',
          serverOnly: page && serverReference(node),
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}
