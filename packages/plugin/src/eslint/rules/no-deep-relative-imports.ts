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

export const noDeepRelativeImports: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require path aliases for cross-project imports.',
    },
    schema: [
      {
        type: 'object',
        properties: { workspaceRoot: { type: 'string' } },
        additionalProperties: false,
      },
    ],
    messages: {
      crossProject:
        'Cross-project relative import "{{specifier}}" must use the target project path alias.',
    },
  },
  create(context) {
    const filename = context.filename;
    const workspaceRoot =
      (context.options[0] as { readonly workspaceRoot?: string } | undefined)
        ?.workspaceRoot ?? context.cwd;
    const sourceProject = findProjectMetadata(filename, workspaceRoot);
    const inspect = (node: Rule.Node) => {
      const specifier = importedValue(node);
      if (!specifier?.startsWith('.')) return;
      const targetPath = resolve(dirname(filename), specifier);
      const targetProject = findProjectMetadata(targetPath, workspaceRoot);
      if (
        !sourceProject ||
        !targetProject ||
        sourceProject.root === targetProject.root
      ) {
        return;
      }
      context.report({
        node,
        messageId: 'crossProject',
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
