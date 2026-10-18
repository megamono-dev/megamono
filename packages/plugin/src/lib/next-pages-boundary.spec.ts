import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProjectGraph } from '@nx/devkit';
import { DEFAULT_MEGAMONO_CONFIG } from './config';
import { checkAdoptionRatchets } from './adoption-ratchets';
import { checkWorkspaceStructure } from './structural-check';
import {
  checkNextPagesBoundary,
  hasBrowserExport,
} from './next-pages-boundary';

let root: string;
const graph: ProjectGraph = {
  nodes: {
    site: {
      name: 'site',
      type: 'app',
      data: {
        root: 'apps/site',
        tags: ['type:app', 'scope:site', 'platform:web', 'visibility:public'],
      },
    },
    producer: {
      name: 'producer',
      type: 'lib',
      data: {
        root: 'packages/producer',
        tags: ['type:util', 'scope:shared', 'platform:node'],
      },
    },
  },
  dependencies: {
    site: [{ source: 'site', target: 'producer', type: 'static' }],
    producer: [],
  },
};
function file(path: string, content: string) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
function violations() {
  return checkNextPagesBoundary(root, join(root, 'apps/site'), graph)
    ?.violations;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'megamono-next-boundary-'));
  file('package.json', '{}');
  file('apps/site/next.config.mjs', 'export default {}');
  file('apps/site/package.json', '{"name":"@fixture/site"}');
  file(
    'apps/site/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        moduleResolution: 'bundler',
        allowJs: true,
        jsx: 'preserve',
        paths: { '@/*': ['./src/*'] },
      },
    }),
  );
  file(
    'packages/producer/package.json',
    JSON.stringify({
      name: '@fixture/producer',
      exports: {
        '.': './dist/index.js',
        './contracts': {
          types: './dist/contracts.d.ts',
          browser: './dist/contracts.js',
          default: './dist/contracts.js',
        },
      },
    }),
  );
  file(
    'apps/site/src/pages/index.tsx',
    'export default function Page() { return null }',
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('allows Node dependencies in API routes, data functions and server-only helper closures without a build', async () => {
  file(
    'apps/site/src/pages/api/signup.ts',
    "import { enqueue } from '@fixture/producer'; export default enqueue;",
  );
  file(
    'apps/site/src/server/data.ts',
    "import { enqueue } from '@fixture/producer'; import fs from 'node:fs'; export const load = () => enqueue(fs.readFileSync('file'));",
  );
  file(
    'apps/site/src/pages/index.tsx',
    `
    import { load } from '../server/data';
    import { enqueue } from '@fixture/producer';
    const helper = () => load();
    export const getServerSideProps = wrapper(async () => ({props: {value: await helper(), queued: enqueue()}}));
    export default function Page() { return null }
  `,
  );
  expect(violations()).toEqual([]);
  const diagnostics = await checkWorkspaceStructure(
    root,
    graph,
    DEFAULT_MEGAMONO_CONFIG,
  );
  expect(diagnostics).toEqual([]);
  expect(
    checkAdoptionRatchets(diagnostics, {
      ...DEFAULT_MEGAMONO_CONFIG,
      adoption: {
        ...DEFAULT_MEGAMONO_CONFIG.adoption,
        ratchets: [
          {
            rule: 'platform-boundary',
            initialCount: 0,
            targetSeverity: 'error',
          },
        ],
      },
    }),
  ).toEqual([]);
});

it.each(['getStaticProps', 'getStaticPaths', 'getServerSideProps'])(
  'recognizes %s functions and dynamic server imports',
  (name) => {
    file(
      'apps/site/src/pages/index.tsx',
      `
    export async function ${name}() { const {enqueue} = await import('@fixture/producer'); return enqueue(); }
    export default function Page() { return null }
  `,
    );
    expect(violations()).toEqual([]);
  },
);

it('allows an explicit browser contracts export and explicit type-only imports from a Node package', () => {
  file(
    'apps/site/src/pages/index.tsx',
    `
    import { validEmail } from '@fixture/producer/contracts';
    import type { Signup } from '@fixture/producer';
    export default function Page(props: Signup) { return validEmail(props.email) }
  `,
  );
  expect(violations()).toEqual([]);
});

it.each([
  "import { enqueue } from '@fixture/producer'; export default function Page() { return enqueue() }",
  "export default function Page() { return import('@fixture/producer') }",
  "export default function Page() { return require('@fixture/producer') }",
  "export { enqueue as default } from '@fixture/producer';",
  "import '@fixture/producer'; export default function Page() { return null }",
  "import {} from '@fixture/producer'; export default function Page() { return null }",
  "export {} from '@fixture/producer'; export default function Page() { return null }",
  "import producer = require('@fixture/producer'); export default function Page() { return producer }",
  "export default function Page() { return require('@fixture/' + 'producer') }",
  "import fs from 'node:fs'; export default function Page() { return fs.readFileSync('file') }",
  "import 'server-only'; export default function Page() { return null }",
])('rejects browser runtime imports: %s', (source) => {
  file('apps/site/src/pages/index.tsx', source);
  expect(violations()?.length).toBeGreaterThan(0);
});

it('rejects a shared import when any binding is used by the page, including alongside data functions', () => {
  file(
    'apps/site/src/pages/index.tsx',
    `
    import { enqueue, secret } from '@fixture/producer';
    export const getServerSideProps = () => enqueue();
    export default function Page() { return secret }
  `,
  );
  expect(violations()?.[0]).toContain('@fixture/producer');
});

it('follows aliases and re-export barrels to reject server helpers reached by the browser', () => {
  file(
    'apps/site/src/server/data.ts',
    "import { enqueue } from '@fixture/producer'; export const load = enqueue;",
  );
  file(
    'apps/site/src/shared/barrel.ts',
    "export {load} from '../server/data';",
  );
  file(
    'apps/site/src/pages/index.tsx',
    "import {load} from '@/shared/barrel'; export default function Page() { return load() }",
  );
  expect(violations()?.[0]).toContain('src/server/data.ts');
});

it('does not mistake a shadowed parameter for a server-only import', () => {
  file(
    'apps/site/src/pages/index.tsx',
    `
    import { enqueue } from '@fixture/producer';
    export const getServerSideProps = (enqueue: () => unknown) => enqueue();
    export default function Page() { return enqueue() }
  `,
  );
  expect(violations()?.[0]).toContain('@fixture/producer');
});

it.each([
  'export default function Page() { return {enqueue} }',
  'export { enqueue }; export default function Page() { return null }',
])(
  'retains imports used in browser shorthand properties and exports: %s',
  (browser) => {
    file(
      'apps/site/src/pages/index.tsx',
      `import {enqueue} from '@fixture/producer';
    export const getServerSideProps = () => enqueue(); ${browser}`,
    );
    expect(violations()?.[0]).toContain('@fixture/producer');
  },
);

it('does not confuse a helper called by both runtimes with a server-only helper', () => {
  file(
    'apps/site/src/pages/index.tsx',
    `import {enqueue} from '@fixture/producer';
    const helper = () => enqueue();
    export const getServerSideProps = () => helper();
    export default function Page() { return helper() }`,
  );
  expect(violations()?.[0]).toContain('@fixture/producer');
});

it('preserves inline type import side effects when verbatimModuleSyntax is enabled', () => {
  file(
    'apps/site/tsconfig.json',
    JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }),
  );
  file(
    'apps/site/src/pages/index.tsx',
    "import {type Signup} from '@fixture/producer'; export default function Page(props: Signup) { return null }",
  );
  expect(violations()?.[0]).toContain('@fixture/producer');
});

it('retains structural type/scope constraints for a Next app', async () => {
  const other = structuredClone(graph);
  other.nodes.producer.data.tags = [
    'type:util',
    'scope:other',
    'platform:node',
  ];
  expect(
    (await checkWorkspaceStructure(root, other, DEFAULT_MEGAMONO_CONFIG)).map(
      (d) => d.code,
    ),
  ).toContain('module-boundaries');
});

it.each(['missing-config', 'app-router', 'non-next'])(
  'does not exempt %s applications',
  async (variant) => {
    if (variant === 'missing-config' || variant === 'non-next')
      rmSync(join(root, 'apps/site/next.config.mjs'));
    if (variant === 'app-router')
      file(
        'apps/site/src/app/page.tsx',
        'export default function Page() { return null }',
      );
    expect(
      (await checkWorkspaceStructure(root, graph, DEFAULT_MEGAMONO_CONFIG)).map(
        (d) => d.code,
      ),
    ).toContain('platform-boundary');
  },
);

it('does not infer browser capability from a subpath name or an unreachable browser condition', () => {
  expect(
    hasBrowserExport(
      { exports: { './contracts': './dist/contracts.js' } },
      './contracts',
      'import',
    ),
  ).toBe(false);
  expect(
    hasBrowserExport(
      {
        exports: {
          './contracts': {
            default: './dist/contracts.js',
            browser: './dist/contracts.js',
          },
        },
      },
      './contracts',
      'import',
    ),
  ).toBe(false);
  expect(
    hasBrowserExport(
      {
        exports: {
          './contracts': {
            types: { browser: './dist/contracts.d.ts' },
            default: './dist/contracts.js',
          },
        },
      },
      './contracts',
      'import',
    ),
  ).toBe(false);
  expect(
    hasBrowserExport(
      { exports: { './contracts': { browser: '../outside.js' } } },
      './contracts',
      'import',
    ),
  ).toBe(false);
});

it.each([
  ['src/pages/api/edge.ts', "export const config = {runtime: 'edge'}"],
  [
    'src/pages/index.tsx',
    "export const config = {runtime: 'experimental-edge'}",
  ],
  ['src/middleware.ts', ''],
  ['src/instrumentation-client.ts', ''],
])('retains Node restrictions for browser/Edge entry %s', (path, config) => {
  file(
    `apps/site/${path}`,
    `import {enqueue} from '@fixture/producer'; ${config}
    export const getServerSideProps = () => enqueue(); export default function Page() { return null }`,
  );
  expect(violations()?.[0]).toContain('@fixture/producer');
});

it('recognizes explicit server data re-exports', () => {
  file(
    'apps/site/src/server/data.ts',
    "import {enqueue} from '@fixture/producer'; export const getServerSideProps = () => enqueue();",
  );
  file(
    'apps/site/src/pages/index.tsx',
    "export {getServerSideProps} from '../server/data'; export default function Page() { return null }",
  );
  expect(violations()).toEqual([]);
});

it('resolves immutable local module names without rejecting public browser assets', () => {
  file(
    'apps/site/src/pages/index.tsx',
    "const path = '/pagefind/pagefind.js'; export default function Page() { return import(/* webpackIgnore: true */ path) }",
  );
  expect(violations()).toEqual([]);
  file(
    'apps/site/src/pages/index.tsx',
    "const path = '@fixture/producer'; export default function Page() { return import(path) }",
  );
  expect(violations()?.[0]).toContain('@fixture/producer');
});
