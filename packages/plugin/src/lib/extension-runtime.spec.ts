import type { ProjectGraph } from '@nx/devkit';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Linter } from 'eslint';
import Ajv2020 from 'ajv/dist/2020';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkExtensionRuntimeBoundary,
  extensionAllowsWebEdge,
  extensionRuntimeEntriesSchema,
} from './extension-runtime';
import { analyzeWorkspaceStructure } from './structural-check';
import { DEFAULT_MEGAMONO_CONFIG } from './config';
import { platformBoundary } from '../eslint/rules/platform-boundary';
import { clearProjectMetadataCache } from '../eslint/project-metadata';

const roots: string[] = [];
afterEach(() => {
  clearProjectMetadataCache();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'megamono-extension-runtime-')),
  );
  roots.push(root);
  const put = (path: string, value: unknown) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  const tags = [
    'platform:extension',
    'type:app',
    'scope:shared',
    'visibility:internal',
  ];
  const policy = {
    version: 1 as const,
    renderers: ['entrypoints/popup/index.html'],
    workers: ['entrypoints/background.ts'],
    rationale:
      'Popup composition reviewed independently of the service worker.',
    decision: 'decision-20261110-extension-renderers',
  };
  const manifest = {
    name: '@fixture/extension',
    nx: { tags },
    megamono: { extension: { runtimeEntries: policy } },
  };
  put('apps/extension/package.json', manifest);
  put(
    'apps/extension/wxt.config.ts',
    "export default {hooks:{'entrypoints:found':()=>{}}};",
  );
  put(
    'apps/extension/entrypoints/popup/index.html',
    '<script type="module" src="./main.ts"></script>',
  );
  put(
    'apps/extension/entrypoints/popup/main.ts',
    "import { button } from '@fixture/ui'; export const popup=button;",
  );
  put(
    'apps/extension/entrypoints/background.ts',
    'export const background=true;',
  );
  put('libs/ui/package.json', {
    name: '@fixture/ui',
    nx: { tags: ['platform:web', 'type:ui', 'scope:shared'] },
  });
  put('libs/ui/src/index.ts', 'export const button=1;');
  put('libs/node/package.json', {
    name: '@fixture/node',
    nx: { tags: ['platform:node', 'type:util', 'scope:shared'] },
  });
  put('libs/node/src/index.ts', 'export const server=1;');
  put('tsconfig.json', {
    compilerOptions: {
      module: 'ESNext',
      moduleResolution: 'Bundler',
      paths: {
        '@fixture/ui': ['./libs/ui/src/index.ts'],
        '@fixture/node': ['./libs/node/src/index.ts'],
      },
    },
  });
  put('apps/extension/tsconfig.json', { extends: '../../tsconfig.json' });
  put('megamono.json', DEFAULT_MEGAMONO_CONFIG);
  put(
    'docs/decisions/renderer.md',
    `---\n${Object.entries({
      id: policy.decision,
      type: 'decision',
      status: 'accepted',
      visibility: 'internal',
      projects: ['extension'],
      topics: [],
      summary: 'Reviewed renderer/worker separation',
      date: '2026-11-10',
      supersedes: null,
      references: [],
      external_references: [],
    })
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n')}\n---\nReviewed source runtime roots.`,
  );
  const graph: ProjectGraph = {
    nodes: {
      extension: {
        name: 'extension',
        type: 'app',
        data: { root: 'apps/extension', tags },
      },
      ui: {
        name: 'ui',
        type: 'lib',
        data: {
          root: 'libs/ui',
          tags: ['platform:web', 'type:ui', 'scope:shared'],
        },
      },
      node: {
        name: 'node',
        type: 'lib',
        data: {
          root: 'libs/node',
          tags: ['platform:node', 'type:util', 'scope:shared'],
        },
      },
    },
    dependencies: {
      extension: [{ source: 'extension', target: 'ui', type: 'static' }],
      ui: [],
      node: [],
    },
  };
  const analyze = () =>
    checkExtensionRuntimeBoundary(root, join(root, 'apps/extension'), graph);
  const lint = (path: string, code?: string) =>
    new Linter({ cwd: root }).verify(
      code ?? readFileSync(join(root, path), 'utf8'),
      [
        {
          files: ['**/*.ts'],
          languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
          plugins: { megamono: { rules: { platform: platformBoundary } } },
          rules: { 'megamono/platform': ['error', { workspaceRoot: root }] },
        },
      ],
      { filename: join(root, path) },
    );
  return { root, put, manifest, policy, graph, analyze, lint };
}

describe('reviewed extension renderer boundaries', () => {
  it('allows only a proven renderer import and reports the accepted contract', async () => {
    const f = fixture();
    const analysis = f.analyze();
    expect(analysis?.complete).toBe(true);
    expect(
      extensionAllowsWebEdge(analysis, join(f.root, 'libs/ui'), 'static'),
    ).toBe(true);
    const structural = await analyzeWorkspaceStructure(
      f.root,
      f.graph,
      DEFAULT_MEGAMONO_CONFIG,
    );
    expect(
      structural.diagnostics.filter((d) => d.code === 'platform-boundary'),
    ).toEqual([]);
    expect(structural.extensionRuntime?.[0]).toMatchObject({
      project: 'extension',
      contract: { decision: f.policy.decision, rationale: f.policy.rationale },
      complete: true,
      applied: [{ target: 'ui', dependencyKind: 'static' }],
    });
    expect(f.lint('apps/extension/entrypoints/popup/main.ts')).toEqual([]);
  });
  it('checks background imports even beside a renderer import', async () => {
    const f = fixture();
    f.put(
      'apps/extension/entrypoints/background.ts',
      "import {button} from '@fixture/ui'; export const background=button;",
    );
    expect(f.analyze()?.complete).toBe(false);
    expect(
      (
        await analyzeWorkspaceStructure(
          f.root,
          f.graph,
          DEFAULT_MEGAMONO_CONFIG,
        )
      ).diagnostics.some((d) => d.code === 'platform-boundary'),
    ).toBe(true);
    expect(
      f
        .lint('apps/extension/entrypoints/background.ts')
        .some((d) => d.message.includes('platform "web"')),
    ).toBe(true);
  });
  it('propagates both renderer and worker reachability through a shared helper', () => {
    const f = fixture();
    f.put(
      'apps/extension/src/shared.ts',
      "export {button} from '@fixture/ui';",
    );
    f.put(
      'apps/extension/entrypoints/popup/main.ts',
      "import {button} from '../../src/shared'; export const popup=button;",
    );
    f.put(
      'apps/extension/entrypoints/background.ts',
      "import {button} from '../src/shared'; export const background=button;",
    );
    const analysis = f.analyze();
    expect(
      analysis?.rendererFiles.has(join(f.root, 'apps/extension/src/shared.ts')),
    ).toBe(true);
    expect(
      analysis?.workerFiles.has(join(f.root, 'apps/extension/src/shared.ts')),
    ).toBe(true);
    expect(
      extensionAllowsWebEdge(analysis, join(f.root, 'libs/ui'), 'static'),
    ).toBe(false);
    expect(f.lint('apps/extension/src/shared.ts').length).toBe(1);
  });
  it('seeds unclassified runtime sources as restricted, including unlisted workers', () => {
    const f = fixture();
    f.put(
      'apps/extension/src/shared.ts',
      "export {button} from '@fixture/ui';",
    );
    f.put(
      'apps/extension/entrypoints/popup/main.ts',
      "export {button} from '../../src/shared';",
    );
    f.put(
      'apps/extension/src/unlisted-entry.ts',
      "export {button} from './shared';",
    );
    expect(f.analyze()?.complete).toBe(false);
    expect(f.lint('apps/extension/src/shared.ts').length).toBe(1);
  });
  it('does not let HTML reclassify a canonical background source', () => {
    const f = fixture();
    f.put(
      'apps/extension/entrypoints/popup/index.html',
      '<script type="module" src="../background.ts"></script>',
    );
    f.manifest.megamono.extension.runtimeEntries.workers = [];
    f.put('apps/extension/package.json', f.manifest);
    f.put(
      'apps/extension/entrypoints/background.ts',
      "export {button} from '@fixture/ui';",
    );
    expect(f.analyze()?.complete).toBe(false);
  });
  it('treats worker constructors in renderer code as worker roots', () => {
    const f = fixture();
    f.put(
      'apps/extension/entrypoints/popup/main.ts',
      "import {button} from '@fixture/ui'; new Worker(new URL('./thread.ts',import.meta.url)); export const popup=button;",
    );
    f.put(
      'apps/extension/entrypoints/popup/thread.ts',
      "export {button} from '@fixture/ui';",
    );
    expect(f.analyze()?.complete).toBe(false);
  });
  it.each(['window.Worker', 'globalThis["SharedWorker"]'])(
    'traces qualified worker constructors %s',
    (constructor) => {
      const f = fixture();
      f.put(
        'apps/extension/entrypoints/popup/main.ts',
        `import {button} from '@fixture/ui'; new ${constructor}(new URL('./thread.ts',import.meta.url));`,
      );
      f.put(
        'apps/extension/entrypoints/popup/thread.ts',
        "export {button} from '@fixture/ui';",
      );
      expect(f.analyze()?.complete).toBe(false);
    },
  );
  it('traces qualified importScripts through an already renderer-reachable module', () => {
    const f = fixture();
    f.put(
      'apps/extension/entrypoints/background.ts',
      "self.importScripts('./popup/main.ts');",
    );
    expect(f.analyze()?.complete).toBe(false);
    expect(f.lint('apps/extension/entrypoints/popup/main.ts').length).toBe(1);
  });
  it('reports a web library loaded directly as a Worker in source lint', () => {
    const f = fixture();
    f.put(
      'apps/extension/entrypoints/popup/main.ts',
      "new Worker(new URL('../../../../libs/ui/src/index.ts',import.meta.url));",
    );
    expect(f.analyze()?.complete).toBe(false);
    expect(f.lint('apps/extension/entrypoints/popup/main.ts').length).toBe(1);
  });
  it('fails lint-only checks through neutral external helpers shared with workers', async () => {
    const f = fixture();
    f.put('libs/shared/package.json', {
      name: '@fixture/shared',
      nx: { tags: ['type:util', 'scope:shared'] },
    });
    f.put(
      'libs/shared/src/index.ts',
      "export {button} from '../../ui/src/index';",
    );
    f.put(
      'apps/extension/entrypoints/popup/main.ts',
      "export {button} from '../../../../libs/shared/src/index';",
    );
    f.put(
      'apps/extension/entrypoints/background.ts',
      "export {button} from '../../../libs/shared/src/index';",
    );
    expect(f.analyze()?.complete).toBe(false);
    expect(
      f
        .lint('apps/extension/entrypoints/background.ts')
        .some((d) => d.message.includes('contract is incomplete')),
    ).toBe(true);
    const result = await analyzeWorkspaceStructure(
      f.root,
      f.graph,
      DEFAULT_MEGAMONO_CONFIG,
    );
    expect(
      result.diagnostics.some(
        (d) =>
          d.code === 'platform-boundary' &&
          d.message.includes('worker or unclassified'),
      ),
    ).toBe(true);
  });
  it('rejects graph package names mapped to a different source owner', () => {
    const f = fixture();
    f.put('tsconfig.json', {
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        paths: { '@fixture/ui': ['./libs/node/src/index.ts'] },
      },
    });
    expect(f.analyze()?.complete).toBe(false);
    expect(
      f
        .analyze()
        ?.issues.some((issue) => issue.message.includes('does not belong')),
    ).toBe(true);
    expect(
      f.lint('apps/extension/entrypoints/popup/main.ts').length,
    ).toBeGreaterThan(0);
  });
  it('rejects unclassified owned external sources when graph evidence is absent', () => {
    const f = fixture();
    f.put('libs/unclassified/index.ts', 'export const value=1;');
    f.put(
      'apps/extension/entrypoints/popup/main.ts',
      "export {value} from '../../../../libs/unclassified';",
    );
    const result = checkExtensionRuntimeBoundary(
      f.root,
      join(f.root, 'apps/extension'),
    );
    expect(result?.complete).toBe(false);
    expect(
      result?.issues.some((issue) => issue.message.includes('Cannot classify')),
    ).toBe(true);
    expect(f.lint('apps/extension/entrypoints/popup/main.ts').length).toBe(1);
  });
  it.each(['static', 'dynamic'] as const)(
    'preserves %s edge classification',
    (kind) => {
      const f = fixture();
      if (kind === 'dynamic')
        f.put(
          'apps/extension/entrypoints/popup/main.ts',
          "export const popup=import('@fixture/ui');",
        );
      const analysis = f.analyze();
      expect(
        extensionAllowsWebEdge(analysis, join(f.root, 'libs/ui'), kind),
      ).toBe(true);
      expect(
        extensionAllowsWebEdge(
          analysis,
          join(f.root, 'libs/ui'),
          kind === 'static' ? 'dynamic' : 'static',
        ),
      ).toBe(false);
      expect(
        extensionAllowsWebEdge(analysis, join(f.root, 'libs/ui'), 'implicit'),
      ).toBe(false);
    },
  );
  it('does not exempt an implicit edge merely because a separate renderer import exists', async () => {
    const f = fixture();
    f.graph.dependencies.extension.push({
      source: 'extension',
      target: 'ui',
      type: 'implicit',
    });
    const result = await analyzeWorkspaceStructure(
      f.root,
      f.graph,
      DEFAULT_MEGAMONO_CONFIG,
    );
    expect(
      result.diagnostics.filter((d) => d.code === 'platform-boundary'),
    ).toHaveLength(1);
  });
  it.each(['nonliteral', 'unresolved'] as const)(
    'fails closed for %s imports',
    (kind) => {
      const f = fixture();
      f.put(
        'apps/extension/entrypoints/background.ts',
        kind === 'nonliteral'
          ? "const name='./unknown'; import(name);"
          : "import './unknown';",
      );
      expect(f.analyze()?.complete).toBe(false);
      expect(
        extensionAllowsWebEdge(f.analyze(), join(f.root, 'libs/ui'), 'static'),
      ).toBe(false);
    },
  );
  it('preserves Node builtin and Node project restrictions', () => {
    const f = fixture();
    f.put(
      'apps/extension/entrypoints/popup/main.ts',
      "import 'node:fs'; import '@fixture/node'; import '@fixture/ui';",
    );
    const analysis = f.analyze();
    expect(analysis?.issues.filter((i) => i.kind === 'node')).toHaveLength(2);
    expect(
      f
        .lint('apps/extension/entrypoints/popup/main.ts')
        .filter(
          (d) =>
            d.message.includes('Node') || d.message.includes('platform:node'),
        ),
    ).toHaveLength(2);
  });
  it('validates unsaved source text instead of trusting an earlier renderer proof', () => {
    const f = fixture();
    expect(f.lint('apps/extension/entrypoints/background.ts')).toEqual([]);
    const code =
      "import {button} from '@fixture/ui'; export const background=button;";
    expect(
      f.lint('apps/extension/entrypoints/background.ts', code).length,
    ).toBe(1);
  });
  it.each(['missing', 'inactive', 'duplicate', 'archived'] as const)(
    'requires independent accepted authority: %s',
    async (state) => {
      const f = fixture();
      const doc = readFileSync(
        join(f.root, 'docs/decisions/renderer.md'),
        'utf8',
      );
      if (state === 'missing')
        rmSync(join(f.root, 'docs/decisions/renderer.md'));
      if (state === 'inactive')
        f.put(
          'docs/decisions/renderer.md',
          doc.replace('status: "accepted"', 'status: "proposed"'),
        );
      if (state === 'duplicate') f.put('docs/decisions/duplicate.md', doc);
      if (state === 'archived') {
        rmSync(join(f.root, 'docs/decisions/renderer.md'));
        f.put('docs/archives/decisions/renderer.md', doc);
      }
      expect(f.analyze()?.policyErrors.length).toBeGreaterThan(0);
      const result = await analyzeWorkspaceStructure(
        f.root,
        f.graph,
        DEFAULT_MEGAMONO_CONFIG,
        new Set([f.policy.decision]),
        new Set(),
      );
      expect(
        result.diagnostics.some((d) => d.code === 'extension-runtime-policy'),
      ).toBe(true);
      expect(
        f.lint('apps/extension/entrypoints/popup/main.ts').length,
      ).toBeGreaterThan(0);
    },
  );
  it('rejects missing/stale HTML, nonmodule scripts and symlinked sources', () => {
    const f = fixture();
    f.put(
      'apps/extension/entrypoints/popup/index.html',
      '<script src="./main.ts"></script>',
    );
    expect(f.analyze()?.policyErrors.length).toBeGreaterThan(0);
    f.put(
      'apps/extension/entrypoints/popup/index.html',
      '<script type="module" src="./missing.ts"></script>',
    );
    expect(f.analyze()?.policyErrors.length).toBeGreaterThan(0);
    rmSync(join(f.root, 'apps/extension/entrypoints/popup/main.ts'));
    symlinkSync(
      join(f.root, 'libs/ui/src/index.ts'),
      join(f.root, 'apps/extension/entrypoints/popup/main.ts'),
    );
    expect(f.analyze()?.policyErrors.length).toBeGreaterThan(0);
  });
  it.each([
    '<template><script type="module" src="./main.ts"></script></template>',
    '<textarea><script type="module" src="./main.ts"></script></textarea>',
    '<noscript><script type="module" src="./main.ts"></script></noscript>',
    '<div data-example=\'<script type="module" src="./main.ts"></script>\'></div>',
    '<script type="module" type=bogus src="./main.ts"></script>',
    '<script type="module" src="./main.ts" src="./background.ts"></script>',
    '<base href="/other/"><script type="module" src="./main.ts"></script>',
  ])('does not attest ambiguous or inert HTML bindings: %s', (html) => {
    const f = fixture();
    f.put('apps/extension/entrypoints/popup/index.html', html);
    expect(f.analyze()?.policyErrors.length).toBeGreaterThan(0);
  });
  it('does not read script text from comments, titles, styles or quoted attributes', () => {
    const f = fixture();
    f.put(
      'apps/extension/entrypoints/popup/index.html',
      '<!doctype html><title>&lt;script&gt;</title><style>.example:after {content:"<script src=bogus>"}</style><div data-sample="<script src=bogus>"></div><!-- <script src="bad"></script> --><script type="module" src="./main.ts"></script>',
    );
    expect(f.analyze()?.complete).toBe(true);
  });
  it('rejects nonliteral worker URLs without relaxing renderer edges', () => {
    const f = fixture();
    f.put(
      'apps/extension/entrypoints/popup/main.ts',
      "import {button} from '@fixture/ui'; const url='./thread.ts'; new Worker(new URL(url,import.meta.url));",
    );
    expect(f.analyze()?.complete).toBe(false);
  });
  it('leaves scope restrictions intact', async () => {
    const f = fixture();
    f.graph.nodes.ui.data.tags = [
      'platform:web',
      'scope:other',
      'type:feature',
    ];
    const result = await analyzeWorkspaceStructure(
      f.root,
      f.graph,
      DEFAULT_MEGAMONO_CONFIG,
    );
    expect(result.diagnostics.some((d) => d.code === 'module-boundaries')).toBe(
      true,
    );
  });
  it('retains legacy strict checking without an explicit contract', async () => {
    const f = fixture();
    f.put('apps/extension/package.json', {
      name: '@fixture/extension',
      nx: f.manifest.nx,
    });
    expect(f.analyze()).toBeUndefined();
    expect(
      (
        await analyzeWorkspaceStructure(
          f.root,
          f.graph,
          DEFAULT_MEGAMONO_CONFIG,
        )
      ).diagnostics.some((d) => d.code === 'platform-boundary'),
    ).toBe(true);
  });
  it('leaves type restrictions intact', async () => {
    const f = fixture();
    f.graph.nodes.ui.data.tags = [
      'platform:web',
      'scope:shared',
      'type:unknown',
    ];
    const result = await analyzeWorkspaceStructure(
      f.root,
      f.graph,
      DEFAULT_MEGAMONO_CONFIG,
    );
    expect(
      result.diagnostics.some(
        (d) =>
          d.code === 'module-boundaries' &&
          d.identity?.constraint === 'module-boundaries:type-direction',
      ),
    ).toBe(true);
    expect(result.extensionRuntime?.[0].applied).toHaveLength(1);
  });
  it('leaves Playstack direction restrictions intact', async () => {
    const f = fixture();
    const source = f.graph.nodes.extension,
      target = f.graph.nodes.ui;
    f.graph.nodes = {
      '@playstack/extension': { ...source, name: '@playstack/extension' },
      '@megamono/ui': { ...target, name: '@megamono/ui' },
    };
    f.graph.dependencies = {
      '@playstack/extension': [
        {
          source: '@playstack/extension',
          target: '@megamono/ui',
          type: 'static',
        },
      ],
      '@megamono/ui': [],
    };
    const result = await analyzeWorkspaceStructure(
      f.root,
      f.graph,
      DEFAULT_MEGAMONO_CONFIG,
    );
    expect(
      result.diagnostics.some((d) => d.code === 'playstack-direction'),
    ).toBe(true);
    expect(result.extensionRuntime?.[0].applied).toHaveLength(1);
  });
});

describe('extension runtime published schema parity', () => {
  const schema = JSON.parse(
    readFileSync(
      join(__dirname, '../../schemas/extension-runtime.schema.json'),
      'utf8',
    ),
  );
  const validate = new Ajv2020({ strict: false }).compile(schema);
  it.each([
    { version: 2 },
    { rationale: ' ' },
    { decision: 'not-reviewed' },
    { renderers: ['../outside.html'] },
    { workers: ['node_modules/tool.ts'] },
    {
      renderers: [
        'entrypoints/popup/index.html',
        'entrypoints/popup/index.html',
      ],
    },
    { unknown: true },
  ])('rejects invalid contract %j', (patch) => {
    const f = fixture();
    const candidate = { ...f.policy, ...patch };
    expect(extensionRuntimeEntriesSchema.safeParse(candidate).success).toBe(
      false,
    );
    expect(validate(candidate)).toBe(false);
  });
});
