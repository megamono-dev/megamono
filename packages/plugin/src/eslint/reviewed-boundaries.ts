import {
  readCachedProjectGraph,
  type ProjectGraph,
  type ProjectGraphProjectNode,
} from '@nx/devkit';
import type { Linter, Rule } from 'eslint';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts = require('typescript');
import { megamonoConfigSchema, type MegamonoConfig } from '../lib/config';
import {
  allowedTypeDependencies,
  boundaryConstraints,
  matchingBoundaryAllowance,
  validateBoundaryAllowances,
} from '../lib/boundary-policy';
import {
  classifyDependency,
  type DependencyFindingIdentity,
} from '../lib/dependency-policy-contract';
import { repositoryOwnedGraph } from '../lib/repository-graph';

type ImportNode = Rule.Node & {
  source?: { value?: unknown };
  callee?: {
    type?: string;
    name?: string;
    object?: { name?: string };
    property?: { name?: string };
  };
  arguments?: readonly { value?: unknown }[];
  moduleReference?: { expression?: { value?: unknown } };
};
function imported(
  node: Rule.Node,
): { specifier: string; kind: 'static' | 'dynamic' } | undefined {
  const value = node as ImportNode;
  let specifier: unknown;
  let kind: 'static' | 'dynamic' = 'static';
  if (
    [
      'ImportDeclaration',
      'ExportNamedDeclaration',
      'ExportAllDeclaration',
    ].includes(node.type)
  )
    specifier = value.source?.value;
  else if (node.type === 'ImportExpression') {
    specifier = value.source?.value;
    kind = 'dynamic';
  } else if (
    node.type === 'CallExpression' &&
    (value.callee?.name === 'require' ||
      (value.callee?.object?.name === 'require' &&
        value.callee.property?.name === 'resolve'))
  )
    specifier = value.arguments?.[0]?.value;
  else if ((node as { type: string }).type === 'TSImportEqualsDeclaration')
    specifier = value.moduleReference?.expression?.value;
  return typeof specifier === 'string' ? { specifier, kind } : undefined;
}
function projectForFile(
  root: string,
  file: string,
  graph: ProjectGraph,
): ProjectGraphProjectNode | undefined {
  const matches = Object.values(graph.nodes).filter((node) => {
    const path = relative(resolve(root, node.data.root), resolve(file));
    return (
      !isAbsolute(path) &&
      path !== '..' &&
      !path.startsWith('../') &&
      !path.startsWith('..\\')
    );
  });
  return matches.sort(
    (left, right) => right.data.root.length - left.data.root.length,
  )[0];
}
function targetProject(
  root: string,
  filename: string,
  specifier: string,
  graph: ProjectGraph,
): ProjectGraphProjectNode | undefined {
  if (specifier.startsWith('.'))
    return projectForFile(root, resolve(dirname(filename), specifier), graph);
  const configFile =
    ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.base.json') ??
    ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (configFile) {
    const config = ts.readConfigFile(configFile, ts.sys.readFile);
    if (!config.error) {
      const options = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        dirname(configFile),
      ).options;
      const result = ts.resolveModuleName(
        specifier,
        filename,
        options,
        ts.sys,
      ).resolvedModule;
      if (result) {
        const project = projectForFile(root, result.resolvedFileName, graph);
        if (project) return project;
      }
      for (const [alias, paths] of Object.entries(options.paths ?? {})) {
        const [before, after] = alias.split('*');
        const match = alias.includes('*')
          ? specifier.startsWith(before) && specifier.endsWith(after)
          : alias === specifier;
        if (!match) continue;
        const wildcard = specifier.slice(
          before.length,
          after ? -after.length : undefined,
        );
        for (const path of paths) {
          const project = projectForFile(
            root,
            resolve(
              options.baseUrl ?? dirname(configFile),
              path.replace('*', wildcard),
            ),
            graph,
          );
          if (project) return project;
        }
      }
    }
  }
  return Object.values(graph.nodes)
    .filter((node) => {
      let name = node.name;
      const manifest = join(root, node.data.root, 'package.json');
      if (existsSync(manifest)) {
        try {
          name = JSON.parse(readFileSync(manifest, 'utf8')).name ?? name;
        } catch {
          /* Nx still enforces unresolved imports. */
        }
      }
      return specifier === name || specifier.startsWith(name + '/');
    })
    .sort((left, right) => right.name.length - left.name.length)[0];
}
function expandCanonicalConstraints(
  options: readonly unknown[],
  source: ProjectGraphProjectNode,
  target: ProjectGraphProjectNode,
  constraints: readonly DependencyFindingIdentity['constraint'][],
): readonly unknown[] {
  const input = options[0] as
    { depConstraints?: readonly Record<string, unknown>[] } | undefined;
  if (!input?.depConstraints) return options;
  const sourceTags = source.data.tags ?? [],
    targetTags = target.data.tags ?? [];
  const value = (tags: readonly string[], family: string) =>
    tags.find((tag) => tag.startsWith(family + ':'))?.slice(family.length + 1);
  return [
    {
      ...input,
      depConstraints: input.depConstraints.map((constraint) => {
        if (
          typeof constraint.sourceTag !== 'string' ||
          !Array.isArray(constraint.onlyDependOnLibsWithTags)
        )
          return constraint;
        for (const kind of constraints) {
          const family =
            kind === 'module-boundaries:type-direction' ? 'type' : 'scope';
          const sourceValue = value(sourceTags, family),
            targetValue = value(targetTags, family);
          if (
            !sourceValue ||
            !targetValue ||
            constraint.sourceTag !== `${family}:${sourceValue}`
          )
            continue;
          const expected =
            family === 'type'
              ? allowedTypeDependencies[sourceValue]?.map(
                  (tag) => `type:${tag}`,
                )
              : sourceValue === 'shared'
                ? ['scope:shared']
                : [`scope:${sourceValue}`, 'scope:shared'];
          if (
            !expected ||
            JSON.stringify([...constraint.onlyDependOnLibsWithTags].sort()) !==
              JSON.stringify([...expected].sort())
          )
            continue;
          return {
            ...constraint,
            onlyDependOnLibsWithTags: [
              ...constraint.onlyDependOnLibsWithTags,
              `${family}:${targetValue}`,
            ],
          };
        }
        return constraint;
      }),
    },
    ...options.slice(1),
  ];
}

function policyWorkspaceRoot(cwd: string): string {
  let current = resolve(cwd);
  while (true) {
    if (
      existsSync(join(current, 'megamono.json')) &&
      existsSync(join(current, 'nx.json'))
    )
      return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

/** Per-import delegation preserves all Nx safety checks, including later constraints. */
export function createReviewedBoundaryRule(
  delegate: Rule.RuleModule,
  config: MegamonoConfig,
  loadGraph: () => ProjectGraph = readCachedProjectGraph,
): Rule.RuleModule {
  return {
    meta: {
      ...delegate.meta,
      messages: {
        ...delegate.meta?.messages,
        reviewedPolicy: '{{message}}',
        direction: '{{source}} may not depend on {{target}} ({{constraint}}).',
      },
    },
    create(context) {
      let graph: ProjectGraph;
      try {
        graph = repositoryOwnedGraph(loadGraph());
      } catch {
        return {
          Program(node) {
            context.report({
              node,
              messageId: 'reviewedPolicy',
              data: {
                message:
                  'The reviewed boundary policy requires a current Nx project graph. Refresh the graph; no allowance was applied.',
              },
            });
          },
        };
      }
      const root = policyWorkspaceRoot(context.cwd);
      const policy = validateBoundaryAllowances(root, graph, config);
      const base = delegate.create(context);
      const listeners: Rule.RuleListener = {};
      const cache = new Map<string, Rule.RuleListener>();
      const delegateFor = (options: readonly unknown[]) => {
        const key = JSON.stringify(options);
        let result = cache.get(key);
        if (!result) {
          const child = Object.create(context);
          Object.defineProperty(child, 'options', { value: options });
          result = delegate.create(child);
          cache.set(key, result);
        }
        return result;
      };
      const visit = (node: Rule.Node, selector: string) => {
        const importValue = imported(node);
        const source = projectForFile(root, context.filename, graph);
        const target =
          importValue &&
          targetProject(root, context.filename, importValue.specifier, graph);
        let options: readonly unknown[] = context.options;
        if (source && target && source.name !== target.name && importValue) {
          const classification = classifyDependency(
            source,
            target,
            importValue.kind,
          );
          const allowed: DependencyFindingIdentity['constraint'][] = [];
          for (const constraint of boundaryConstraints(
            source.data.tags ?? [],
            target.data.tags ?? [],
          )) {
            const identity = classification && {
              rule: 'module-boundaries' as const,
              constraint,
              source: source.name,
              target: target.name,
              classification,
            };
            if (identity && matchingBoundaryAllowance(identity, policy.valid))
              allowed.push(constraint);
            else
              context.report({
                node,
                messageId: 'direction',
                data: { source: source.name, target: target.name, constraint },
              });
          }
          options = expandCanonicalConstraints(
            context.options,
            source,
            target,
            allowed,
          );
        }
        const selected =
          options === context.options ? base : delegateFor(options);
        const handler = selected[selector];
        if (typeof handler === 'function')
          (handler as (node: Rule.Node) => void)(node);
      };
      for (const selector of new Set([
        ...Object.keys(base),
        'ImportDeclaration',
        'ExportNamedDeclaration',
        'ExportAllDeclaration',
        'ImportExpression',
        'CallExpression',
        'TSImportEqualsDeclaration',
      ]))
        listeners[selector] = (node: Rule.Node) => visit(node, selector);
      const program = listeners.Program;
      listeners.Program = (node) => {
        for (const diagnostic of policy.diagnostics)
          context.report({
            node,
            messageId: 'reviewedPolicy',
            data: { message: diagnostic.message },
          });
        if (typeof program === 'function') program(node);
      };
      return listeners;
    },
  };
}

type FlatConfig = Linter.Config & { plugins?: Record<string, unknown> };
/** Opt-in only: transfer original Nx options without changing other flat config entries. */
export function withBoundaryAllowances(
  config: MegamonoConfig,
  entries: readonly Linter.Config[],
): Linter.Config[] {
  if (config?.conventions?.boundaryAllowances === undefined)
    return [...entries];
  const parsed = megamonoConfigSchema.safeParse(config);
  if (!parsed.success || parsed.data.version !== 2)
    throw new Error(
      'Reviewed boundary allowances require a valid version 2 configuration.',
    );
  const nxPlugin = entries
    .map((entry) => (entry as FlatConfig).plugins?.['@nx'])
    .find(Boolean) as { rules?: Record<string, Rule.RuleModule> } | undefined;
  let delegate = nxPlugin?.rules?.['enforce-module-boundaries'];
  if (!delegate) {
    const nx = createRequire(join(process.cwd(), 'package.json'))(
      '@nx/eslint-plugin',
    ) as {
      rules?: Record<string, Rule.RuleModule>;
      default?: { rules?: Record<string, Rule.RuleModule> };
    };
    delegate = (nx.rules ?? nx.default?.rules)?.['enforce-module-boundaries'];
  }
  if (!delegate)
    throw new Error(
      'The reviewed boundary wrapper requires the installed Nx module-boundaries rule.',
    );
  const plugin = {
    meta: { name: '@megamono/reviewed-boundaries', version: '1' },
    rules: {
      'module-boundaries': createReviewedBoundaryRule(delegate, parsed.data),
    },
  };
  const rewritten = entries.map((entry) => {
    if (
      !entry.rules ||
      !Object.hasOwn(entry.rules, '@nx/enforce-module-boundaries')
    )
      return entry;
    const rules = { ...entry.rules };
    rules['megamono-reviewed/module-boundaries'] =
      rules['@nx/enforce-module-boundaries'];
    delete rules['@nx/enforce-module-boundaries'];
    return { ...entry, rules };
  });
  return [
    {
      plugins: { 'megamono-reviewed': plugin },
      rules: { '@nx/enforce-module-boundaries': 'off' },
    },
    ...rewritten,
  ];
}
