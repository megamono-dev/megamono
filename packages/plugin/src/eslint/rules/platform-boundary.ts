import { builtinModules } from 'node:module';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import ignore = require('ignore');
import type { Rule } from 'eslint';
import { findProjectMetadata, filePlatform } from '../project-metadata';
import { nextPagesLintContext } from '../next-pages';
import { extensionRuntimeLintContext } from '../extension-runtime';
import {
  nextPagesImports,
  nextPagesEdgeRuntime,
} from '../../lib/next-pages-imports';

type SourceNode = Rule.Node & {
  readonly source?: { readonly value?: unknown };
  readonly importKind?: string;
  readonly exportKind?: string;
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

interface PlatformBoundaryOptions {
  readonly workspaceRoot?: string;
  readonly docsRoot?: string;
  readonly nodeFiles?: readonly string[];
}

/** Project-relative path, or undefined outside the project. */
function projectRelative(root: string, filename: string): string | undefined {
  const path = relative(root, resolve(filename)).replaceAll('\\', '/');
  return !path || isAbsolute(path) || path === '..' || path.startsWith('../')
    ? undefined
    : path;
}

/**
 * A Next.js App Router route handler (`app/**\/route.ts`) runs on the server
 * in the Node.js runtime unless it opts into the Edge runtime.
 */
function isNextAppRouteHandler(root: string, filename: string): boolean {
  const path = projectRelative(root, filename);
  if (!path || !/^(?:src\/)?app\/(?:.+\/)?route\.[cm]?[jt]sx?$/.test(path))
    return false;
  try {
    return readdirSync(root).some((entry) =>
      /^next\.config\.(?:[cm]?js|ts|mts|cts)$/.test(entry),
    );
  } catch {
    return false;
  }
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
        properties: {
          workspaceRoot: { type: 'string' },
          docsRoot: { type: 'string' },
          nodeFiles: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Gitignore-style paths relative to the linted file's project root that run only in Node (for example scripts/** for build tooling). Files that a Next.js page or extension runtime entry reaches keep their runtime platform.",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      extensionRuntimePolicy: '{{message}}',
      nodeBuiltin:
        'Project platform "{{platform}}" cannot import Node built-in "{{specifier}}".',
      projectPlatform:
        'Project platform "{{source}}" cannot import platform "{{target}}" through "{{specifier}}".',
    },
  },
  create(context) {
    const filename = context.filename;
    const options = (context.options[0] ?? {}) as PlatformBoundaryOptions;
    const workspaceRoot = options.workspaceRoot ?? context.cwd;
    const sourceProject = findProjectMetadata(filename, workspaceRoot);
    const extension = extensionRuntimeLintContext(
      workspaceRoot,
      sourceProject,
      filename,
      context.sourceCode.text,
      options.docsRoot,
    );
    const runtimeFilename = existsSync(filename)
      ? realpathSync(filename)
      : resolve(filename);
    const reportedRuntimeIssues = new Set<string>();
    const next = nextPagesLintContext(workspaceRoot, sourceProject, filename);
    const currentEdge =
      next && nextPagesEdgeRuntime(filename, context.sourceCode.text);
    const relativePath =
      sourceProject && projectRelative(sourceProject.root, filename);
    const appRouteHandler =
      sourceProject?.tags.includes('platform:web') === true &&
      isNextAppRouteHandler(sourceProject.root, filename) &&
      !nextPagesEdgeRuntime(filename, context.sourceCode.text);
    // Declared Node tooling, unless a Next.js page already reaches the file.
    const nodeFile =
      relativePath !== undefined &&
      (options.nodeFiles?.length ?? 0) > 0 &&
      ignore()
        .add([...(options.nodeFiles ?? [])])
        .ignores(relativePath) &&
      !next?.analysis.browserFiles.has(resolve(filename));
    const sourcePlatform = currentEdge
      ? 'web'
      : next?.serverOnly || appRouteHandler || nodeFile
        ? 'node'
        : filePlatform(sourceProject, filename);
    const nextImports = next?.page
      ? nextPagesImports(
          filename,
          context.sourceCode.text,
          !nextPagesEdgeRuntime(filename, context.sourceCode.text),
        )
      : undefined;
    // A Jest or Vitest Node/jsdom/happy-dom test runs in a Node process even
    // when the application under test is a browser frontend. Require both a
    // test filename and an explicit leading environment comment (Jest reads
    // docblocks; Vitest also reads `// @vitest-environment`); never infer this
    // for production.
    const firstStatement =
      context.sourceCode.ast.body[0]?.range?.[0] ?? Infinity;
    const nodeHostedTest =
      /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(filename) &&
      context.sourceCode
        .getAllComments()
        .some(
          (comment) =>
            comment.range !== undefined &&
            comment.range[0] < firstStatement &&
            (comment.type === 'Block'
              ? /(?:^|\n)\s*\*?\s*@(?:jest-environment\s+(?:node|jsdom)|vitest-environment\s+(?:node|jsdom|happy-dom))\s*(?:\n|\*?\s*$)/.test(
                  comment.value,
                )
              : /^\s*@vitest-environment\s+(?:node|jsdom|happy-dom)\s*$/.test(
                  comment.value,
                )),
        );
    const inspect = (node: Rule.Node) => {
      if (
        (node as SourceNode).importKind === 'type' ||
        (node as SourceNode).exportKind === 'type'
      )
        return;
      const specifier = importedValue(node);
      if (!specifier || !sourceProject) return;
      const nextImport = nextImports?.find(
        (entry) => entry.start === node.range?.[0],
      );
      if (nextImports && !nextImport) return;
      const runtimePlatform = nextImport?.serverOnly ? 'node' : sourcePlatform;
      if (
        isNodeBuiltin(specifier) &&
        runtimePlatform !== 'node' &&
        !nodeHostedTest
      ) {
        reportedRuntimeIssues.add(`${node.range?.[0]}:node`);
        context.report({
          node,
          messageId: 'nodeBuiltin',
          data: { platform: runtimePlatform ?? 'neutral', specifier },
        });
        return;
      }
      const extensionUse = extension?.uses.find(
        (use) => use.file === runtimeFilename && use.specifier === specifier,
      );
      if (extensionUse) {
        if (extension?.complete && extensionUse.rendererOnly) return;
        reportedRuntimeIssues.add(`${node.range?.[0]}:web`);
        context.report({
          node,
          messageId: 'projectPlatform',
          data: {
            source: 'extension worker/unclassified',
            target: 'web',
            specifier,
          },
        });
        return;
      }
      const extensionNode = extension?.issues.find(
        (issue) =>
          issue.file === runtimeFilename &&
          issue.start === node.range?.[0] &&
          issue.kind === 'node',
      );
      if (extensionNode) {
        reportedRuntimeIssues.add(`${node.range?.[0]}:node`);
        context.report({
          node,
          messageId: 'extensionRuntimePolicy',
          data: { message: extensionNode.message },
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
        runtimePlatform === targetPlatform ||
        ((next || appRouteHandler || nodeFile) &&
          runtimePlatform === 'node' &&
          sourceProject.root === targetProject.root)
      ) {
        return;
      }
      context.report({
        node,
        messageId: 'projectPlatform',
        data: {
          source: runtimePlatform ?? 'neutral',
          target: targetPlatform,
          specifier,
        },
      });
    };
    return {
      'Program:exit'(node) {
        for (const message of extension?.policyErrors ?? [])
          context.report({
            node,
            messageId: 'extensionRuntimePolicy',
            data: { message },
          });
        for (const issue of extension?.issues ?? [])
          if (
            issue.file === runtimeFilename &&
            !reportedRuntimeIssues.has(`${issue.start}:${issue.kind}`)
          ) {
            reportedRuntimeIssues.add(`${issue.start}:${issue.kind}`);
            context.report({
              node,
              messageId: 'extensionRuntimePolicy',
              data: { message: issue.message },
            });
          }
        // The contract qualifies the whole root set. A lint-only invocation must
        // not pass through a neutral shared helper whose transitive source fails.
        const externalIssue = extension?.issues.find(
          (issue) => issue.file !== runtimeFilename,
        );
        if (
          externalIssue &&
          !reportedRuntimeIssues.size &&
          !extension?.policyErrors.length
        )
          context.report({
            node,
            messageId: 'extensionRuntimePolicy',
            data: {
              message: `Extension runtime contract is incomplete: ${externalIssue.file}: ${externalIssue.message}`,
            },
          });
      },
      ImportDeclaration: inspect,
      ExportNamedDeclaration: inspect,
      ExportAllDeclaration: inspect,
      ImportExpression: inspect,
      CallExpression: inspect,
    };
  },
};
