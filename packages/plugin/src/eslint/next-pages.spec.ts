import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Linter, RuleTester } from 'eslint';
import { platformBoundary } from './rules/platform-boundary';
import { clearProjectMetadataCache } from './project-metadata';
import { clearNextPagesLintCache } from './next-pages';

const root = mkdtempSync(join(tmpdir(), 'megamono-next-eslint-'));
const app = join(root, 'apps/site');
function file(path: string, content: string) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
file('package.json', '{}');
file(
  'apps/site/package.json',
  JSON.stringify({
    name: '@fixture/site',
    nx: {
      tags: ['type:app', 'platform:web', 'scope:site', 'visibility:public'],
    },
  }),
);
file('apps/site/next.config.mjs', 'export default {}');
file(
  'apps/site/src/pages/index.js',
  "import {load} from '../server/data.js'; export const getServerSideProps = () => load(); export default function Page() { return null }",
);
file(
  'apps/site/src/server/data.js',
  "import fs from 'node:fs'; export const load = () => fs.readFileSync('file');",
);
file(
  'apps/site/src/pages/browser.js',
  "import {load} from '../shared/data.js'; export default function Page() { return load() }",
);
file(
  'apps/site/src/shared/data.js',
  "import fs from 'node:fs'; export const load = () => fs.readFileSync('file');",
);
file(
  'packages/node/package.json',
  JSON.stringify({
    nx: { tags: ['type:util', 'scope:shared', 'platform:node'] },
  }),
);

afterAll(() => {
  clearProjectMetadataCache();
  clearNextPagesLintCache();
  rmSync(root, { recursive: true, force: true });
});

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
});
const options = [{ workspaceRoot: root }];
tester.run('Next Pages platform-boundary', platformBoundary, {
  valid: [
    {
      filename: join(app, 'src/pages/api/signup.js'),
      code: "import fs from 'node:fs'; export default () => fs.readFileSync('file');",
      options,
    },
    {
      filename: join(app, 'src/pages/_document.js'),
      code: "import fs from 'node:fs'; export default () => fs.readFileSync('file');",
      options,
    },
    {
      filename: join(app, 'next.config.mjs'),
      code: "import path from 'node:path'; export default {distDir: path.join('out', 'next')};",
      options,
    },
    {
      filename: join(app, 'src/server/data.js'),
      code: "import fs from 'node:fs'; export const load = () => fs.readFileSync('file');",
      options,
    },
    ...['getServerSideProps', 'getStaticProps', 'getStaticPaths'].map(
      (name) => ({
        filename: join(app, 'src/pages/index.js'),
        options,
        code: `import fs from 'node:fs'; export const ${name} = wrapper(async () => fs.readFileSync('file')); export default function Page() { return null }`,
      }),
    ),
    {
      filename: join(app, 'src/pages/index.js'),
      code: "import {data} from '../../../../packages/node/src/index.js'; export const getServerSideProps = () => data(); export default function Page() { return null }",
      options,
    },
    {
      filename: join(app, 'src/pages/index.js'),
      code: "export async function getServerSideProps() { return import('node:fs') } export default function Page() { return null }",
      options,
    },
  ],
  invalid: [
    {
      filename: join(app, 'src/pages/index.js'),
      code: "import fs from 'node:fs'; export default function Page() { return fs.readFileSync('file') }",
      options,
      errors: [{ messageId: 'nodeBuiltin' }],
    },
    {
      filename: join(app, 'src/shared/data.js'),
      code: "import fs from 'node:fs'; export const load = () => fs.readFileSync('file');",
      options,
      errors: [{ messageId: 'nodeBuiltin' }],
    },
    {
      filename: join(app, 'src/pages/index.js'),
      code: "import {data} from '../../../../packages/node/src/index.js'; export default function Page() { return data() }",
      options,
      errors: [{ messageId: 'projectPlatform' }],
    },
    {
      filename: join(app, 'src/pages/index.js'),
      code: "import fs from 'node:fs'; export const getServerSideProps = () => fs.readFileSync('file'); export default function Page() { return {fs} }",
      options,
      errors: [{ messageId: 'nodeBuiltin' }],
    },
    {
      filename: join(app, 'src/pages/api/edge.js'),
      code: "import fs from 'node:fs'; export const config = {runtime: 'edge'}; export default () => fs.readFileSync('file');",
      options,
      errors: [{ messageId: 'nodeBuiltin' }],
    },
    {
      filename: join(app, 'src/pages/index.js'),
      code: "import fs from 'node:fs'; export const runtime = 'edge'; export const getServerSideProps = () => fs.readFileSync('file'); export default function Page() { return null }",
      options,
      errors: [{ messageId: 'nodeBuiltin' }],
    },
  ],
});

it('refreshes server-only classification when browser reachability changes in an editor session', () => {
  const linter = new Linter({ cwd: root });
  const config = [
    {
      files: ['**/*.js'],
      plugins: { test: { rules: { boundary: platformBoundary } } },
      rules: { 'test/boundary': ['error', { workspaceRoot: root }] },
    },
  ];
  const filename = join(app, 'src/server/data.js');
  const source =
    "import fs from 'node:fs'; export const load = () => fs.readFileSync('file');";
  expect(linter.verify(source, config, { filename })).toEqual([]);
  file(
    'apps/site/src/pages/new-browser.js',
    "import {load} from '../server/data.js'; export default function Page() { return load() }",
  );
  expect(
    linter.verify(source, config, { filename }).map((m) => m.messageId),
  ).toContain('nodeBuiltin');
});
