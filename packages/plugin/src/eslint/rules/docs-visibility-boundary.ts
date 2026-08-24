import type { Rule } from 'eslint';
import { dirname, resolve } from 'node:path';
import { findProjectMetadata } from '../project-metadata';

type SourceNode = Rule.Node & {
  readonly source?: { readonly value?: unknown };
};
type ImportExpressionNode = Rule.Node & {
  readonly source?: { readonly value?: unknown };
};
type CallNode = Rule.Node & {
  readonly callee?: { readonly type?: string; readonly name?: string };
  readonly arguments?: ReadonlyArray<{ readonly value?: unknown }>;
};

function importedValue(node: Rule.Node): string | undefined {
  if (
    node.type === 'ImportDeclaration' ||
    node.type === 'ExportNamedDeclaration' ||
    node.type === 'ExportAllDeclaration'
  ) {
    const value = (node as SourceNode).source?.value;
    return typeof value === 'string' ? value : undefined;
  }
  if (node.type === 'ImportExpression') {
    const value = (node as ImportExpressionNode).source?.value;
    return typeof value === 'string' ? value : undefined;
  }
  if (node.type === 'CallExpression') {
    const call = node as CallNode;
    if (call.callee?.type !== 'Identifier' || call.callee.name !== 'require')
      return undefined;
    const value = call.arguments?.[0]?.value;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function isUnrestrictedRepoDocsEntry(
  specifier: string,
  filename: string,
  workspaceRoot: string,
): boolean {
  if (
    specifier === 'content-collections' ||
    specifier.startsWith('content-collections/')
  ) {
    return specifier !== 'content-collections/public-repo-docs';
  }
  if (!specifier.startsWith('.')) return false;
  const generatedRoot = resolve(workspaceRoot, '.content-collections');
  const target = resolve(dirname(filename), specifier);
  return target === generatedRoot || target.startsWith(`${generatedRoot}/`);
}

export const docsVisibilityBoundary: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Prevent public applications from importing unrestricted repository documentation.',
    },
    schema: [
      {
        type: 'object',
        properties: { workspaceRoot: { type: 'string' } },
        additionalProperties: false,
      },
    ],
    messages: {
      unrestricted:
        'Public application imports from "{{specifier}}" can expose internal repository documents. Import "content-collections/public-repo-docs" instead.',
    },
  },
  create(context) {
    const filename = context.filename;
    const workspaceRoot =
      (context.options[0] as { readonly workspaceRoot?: string } | undefined)
        ?.workspaceRoot ?? context.cwd;
    const sourceProject = findProjectMetadata(context.filename, workspaceRoot);
    const isPublicApplication =
      sourceProject?.tags.includes('type:app') === true &&
      sourceProject.tags.includes('visibility:public');
    const inspect = (node: Rule.Node) => {
      if (!isPublicApplication) return;
      const specifier = importedValue(node);
      if (
        !specifier ||
        !isUnrestrictedRepoDocsEntry(specifier, filename, workspaceRoot)
      )
        return;
      context.report({
        node,
        messageId: 'unrestricted',
        data: { specifier },
      });
    };
    return {
      ImportDeclaration: inspect,
      ExportNamedDeclaration: inspect,
      ExportAllDeclaration: inspect,
      ImportExpression: inspect,
      CallExpression: inspect,
    };
  },
};
