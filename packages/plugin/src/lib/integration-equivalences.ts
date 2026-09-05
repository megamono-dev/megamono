import type { Tree } from '@nx/devkit';
import ts = require('typescript');

export interface IntegrationEquivalence {
  readonly key: string;
  readonly kind: 'environment' | 'module' | 'provider' | 'template';
  readonly value: string;
  readonly file?: string;
  readonly export?: string;
  readonly authority: 'reviewed-application-mapping';
}

export function validateIntegrationEquivalences(
  tree: Tree,
  selections: Readonly<Record<string, string>>,
  available: ReadonlyMap<string, IntegrationEquivalence['kind']>,
): IntegrationEquivalence[] {
  return Object.entries(selections)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const kind = available.get(key);
      if (!kind)
        throw new Error(`Unknown or inactive integration equivalence: ${key}.`);
      if (kind === 'environment') {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(value))
          throw new Error(
            `Equivalence ${key} must be an environment variable name, never a secret value.`,
          );
        return { key, kind, value, authority: 'reviewed-application-mapping' };
      }
      const match = /^existing:([^#]+)(?:#([A-Za-z_$][\w$]*))?$/.exec(value);
      if (!match)
        throw new Error(
          `Equivalence ${key} must use existing:<workspace-file>#<export> (export optional for templates).`,
        );
      const [, file, exported] = match;
      if (
        /^(?:\/|[A-Za-z]:)/.test(file) ||
        file.includes('\\') ||
        file
          .split('/')
          .some((part) => !part || part === '.' || part === '..') ||
        /(?:^|\/)node_modules\//.test(file)
      )
        throw new Error(
          `Equivalence ${key} requires a safe application-owned workspace file.`,
        );
      const content = tree.read(file, 'utf8');
      if (content === null)
        throw new Error(`Equivalence ${key} references missing file ${file}.`);
      if (kind !== 'template' && !exported)
        throw new Error(
          `Equivalence ${key} requires an explicit exported symbol.`,
        );
      if (exported) {
        const source = ts.createSourceFile(
          file,
          content,
          ts.ScriptTarget.Latest,
          true,
        );
        const found = source.statements.some((statement) => {
          if (
            ts.isExportDeclaration(statement) &&
            statement.exportClause &&
            ts.isNamedExports(statement.exportClause)
          )
            return statement.exportClause.elements.some(
              (element) => element.name.text === exported,
            );
          if (
            !ts.canHaveModifiers(statement) ||
            !ts
              .getModifiers(statement)
              ?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
              )
          )
            return false;
          if (
            ts.isClassDeclaration(statement) ||
            ts.isFunctionDeclaration(statement)
          )
            return statement.name?.text === exported;
          return (
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
              (declaration) =>
                ts.isIdentifier(declaration.name) &&
                declaration.name.text === exported,
            )
          );
        });
        if (!found)
          throw new Error(
            `Equivalence ${key}: ${file} does not export ${exported}.`,
          );
      }
      return {
        key,
        kind,
        value,
        file,
        ...(exported ? { export: exported } : {}),
        authority: 'reviewed-application-mapping',
      };
    });
}
