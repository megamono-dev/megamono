import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Rule } from 'eslint';
import { findProjectMetadata, filePlatform } from '../project-metadata';

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

const nodeBuiltins = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, '')]),
);

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

function isNodeBuiltin(specifier: string): boolean {
  const normalized = specifier.replace(/^node:/, '');
  return (
    nodeBuiltins.has(normalized) || nodeBuiltins.has(normalized.split('/')[0])
  );
}

export const platformBoundary: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce platform-safe imports at source level.',
    },
    schema: [
      {
        type: 'object',
        properties: { workspaceRoot: { type: 'string' } },
        additionalProperties: false,
      },
    ],
    messages: {
      nodeBuiltin:
        'Project platform "{{platform}}" cannot import Node built-in "{{specifier}}".',
      projectPlatform:
        'Project platform "{{source}}" cannot import platform "{{target}}" through "{{specifier}}".',
    },
  },
  create(context) {
    const filename = context.filename;
    const workspaceRoot =
      (context.options[0] as { readonly workspaceRoot?: string } | undefined)
        ?.workspaceRoot ?? context.cwd;
    const sourceProject = findProjectMetadata(filename, workspaceRoot);
    const sourcePlatform = filePlatform(sourceProject, filename);
    const inspect = (node: Rule.Node) => {
      const specifier = importedValue(node);
      if (!specifier || !sourceProject) return;
      if (isNodeBuiltin(specifier) && sourcePlatform !== 'node') {
        context.report({
          node,
          messageId: 'nodeBuiltin',
          data: { platform: sourcePlatform ?? 'neutral', specifier },
        });
        return;
      }
      if (!specifier.startsWith('.')) return;
      const targetPath = resolve(dirname(filename), specifier);
      const targetProject = findProjectMetadata(targetPath, workspaceRoot);
      const targetPlatform = filePlatform(targetProject, targetPath);
      if (
        !targetProject ||
        !targetPlatform ||
        sourcePlatform === targetPlatform
      ) {
        return;
      }
      context.report({
        node,
        messageId: 'projectPlatform',
        data: {
          source: sourcePlatform ?? 'neutral',
          target: targetPlatform,
          specifier,
        },
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
