import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuleTester } from 'eslint';
import { DEFAULT_MEGAMONO_CONFIG } from '../lib/config';
import { megamonoEslintPlugin } from './plugin';
import { clearProjectMetadataCache } from './project-metadata';
import { docsVisibilityBoundary } from './rules/docs-visibility-boundary';
import { noBareJsxStrings } from './rules/no-bare-jsx-strings';
import { noDeepRelativeImports } from './rules/no-deep-relative-imports';
import { platformBoundary } from './rules/platform-boundary';

const root = mkdtempSync(join(tmpdir(), 'megamono-eslint-'));
const webRoot = join(root, 'apps/web');
const internalDocsRoot = join(root, 'apps/internal-docs');
const publicDocsRoot = join(root, 'apps/public-docs');
const nodeRoot = join(root, 'packages/node-data');
const neutralRoot = join(root, 'packages/neutral');
const desktopRoot = join(root, 'apps/desktop');
mkdirSync(join(desktopRoot, 'src-tauri'), { recursive: true });
writeFileSync(join(desktopRoot, 'src-tauri/Cargo.toml'), '[package]');
writeFileSync(join(desktopRoot, 'src-tauri/tauri.conf.json'), '{}');
writeFileSync(
  join(desktopRoot, 'project.json'),
  JSON.stringify({
    tags: ['platform:rust', 'type:app', 'scope:shared', 'visibility:internal'],
  }),
);
for (const directory of [
  webRoot,
  internalDocsRoot,
  publicDocsRoot,
  nodeRoot,
  neutralRoot,
]) {
  mkdirSync(join(directory, 'src'), { recursive: true });
}
writeFileSync(
  join(webRoot, 'package.json'),
  JSON.stringify({
    nx: {
      tags: ['platform:web', 'scope:site', 'type:app', 'visibility:public'],
    },
  }),
);
writeFileSync(
  join(internalDocsRoot, 'package.json'),
  JSON.stringify({
    nx: {
      tags: ['platform:web', 'scope:docs', 'type:app', 'visibility:internal'],
    },
  }),
);
writeFileSync(
  join(publicDocsRoot, 'package.json'),
  JSON.stringify({
    nx: {
      tags: ['platform:web', 'scope:docs', 'type:app', 'visibility:public'],
    },
  }),
);
writeFileSync(
  join(nodeRoot, 'package.json'),
  JSON.stringify({
    nx: { tags: ['platform:node', 'scope:shared', 'type:data'] },
  }),
);
writeFileSync(
  join(neutralRoot, 'package.json'),
  JSON.stringify({ nx: { tags: ['scope:shared', 'type:util'] } }),
);

afterAll(() => {
  clearProjectMetadataCache();
  rmSync(root, { recursive: true, force: true });
});

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});
const workspaceOption = [{ workspaceRoot: root }];

tester.run('docs-visibility-boundary', docsVisibilityBoundary, {
  valid: [
    {
      filename: join(publicDocsRoot, 'src/page.js'),
      code: "import publicRepoDocs from 'content-collections/public-repo-docs';",
      options: workspaceOption,
    },
    {
      filename: join(internalDocsRoot, 'src/page.js'),
      code: "import repoDocs from 'content-collections/repo-docs';",
      options: workspaceOption,
    },
    {
      filename: join(publicDocsRoot, 'src/page.js'),
      code: "import { component } from '@docs/components';",
      options: workspaceOption,
    },
  ],
  invalid: [
    {
      filename: join(publicDocsRoot, 'src/page.js'),
      code: "import repoDocs from 'content-collections/repo-docs';",
      options: workspaceOption,
      errors: [{ messageId: 'unrestricted' }],
    },
    {
      filename: join(publicDocsRoot, 'src/page.js'),
      code: "const collections = require('content-collections');",
      options: workspaceOption,
      errors: [{ messageId: 'unrestricted' }],
    },
    {
      filename: join(publicDocsRoot, 'src/page.js'),
      code: "export * from 'content-collections/repo-docs';",
      options: workspaceOption,
      errors: [{ messageId: 'unrestricted' }],
    },
    {
      filename: join(publicDocsRoot, 'src/page.js'),
      code: "import docs from 'content-collections/index';",
      options: workspaceOption,
      errors: [{ messageId: 'unrestricted' }],
    },
    {
      filename: join(publicDocsRoot, 'src/page.js'),
      code: "import docs from '../../../.content-collections/index.js';",
      options: workspaceOption,
      errors: [{ messageId: 'unrestricted' }],
    },
  ],
});

tester.run('no-deep-relative-imports', noDeepRelativeImports, {
  valid: [
    {
      filename: join(webRoot, 'src/page.js'),
      code: "import { local } from './local.js';",
      options: workspaceOption,
    },
    {
      filename: join(webRoot, 'src/page.js'),
      code: "import { data } from '@scope/node-data';",
      options: workspaceOption,
    },
  ],
  invalid: [
    {
      filename: join(webRoot, 'src/page.js'),
      code: "import { data } from '../../../packages/node-data/src/index.js';",
      options: workspaceOption,
      errors: [{ messageId: 'crossProject' }],
    },
    {
      filename: join(webRoot, 'src/page.js'),
      code: "const data = require('../../../packages/node-data/src/index.js');",
      options: workspaceOption,
      errors: [{ messageId: 'crossProject' }],
    },
  ],
});

tester.run('platform-boundary', platformBoundary, {
  valid: [
    {
      filename: join(desktopRoot, 'src/main.js'),
      code: "import { view } from '../../web/src/view.js';",
      options: workspaceOption,
    },
    {
      filename: join(desktopRoot, 'vite.config.js'),
      code: "import path from 'node:path';",
      options: workspaceOption,
    },
    {
      filename: join(desktopRoot, 'vitest.config.mjs'),
      code: "import fs from 'node:fs';",
      options: workspaceOption,
    },
    {
      filename: join(nodeRoot, 'src/index.js'),
      code: "import fs from 'node:fs';",
      options: workspaceOption,
    },
    {
      filename: join(webRoot, 'src/page.js'),
      code: "import { value } from '../../../packages/neutral/src/index.js';",
      options: workspaceOption,
    },
  ],
  invalid: [
    {
      filename: join(desktopRoot, 'src/main.js'),
      code: "import fs from 'node:fs';",
      options: workspaceOption,
      errors: [{ messageId: 'nodeBuiltin' }],
    },
    {
      filename: join(desktopRoot, 'src/vite.config.js'),
      code: "import fs from 'node:fs';",
      options: workspaceOption,
      errors: [{ messageId: 'nodeBuiltin' }],
    },
    {
      filename: join(desktopRoot, 'src/main.js'),
      code: "import { data } from '../../../packages/node-data/src/index.js';",
      options: workspaceOption,
      errors: [{ messageId: 'projectPlatform' }],
    },
    {
      filename: join(desktopRoot, 'src/main.js'),
      code: "import config from '../vite.config.js';",
      options: workspaceOption,
      errors: [{ messageId: 'projectPlatform' }],
    },
    {
      filename: join(webRoot, 'src/page.js'),
      code: "import fs from 'node:fs';",
      options: workspaceOption,
      errors: [{ messageId: 'nodeBuiltin' }],
    },
    {
      filename: join(webRoot, 'src/page.js'),
      code: "import { data } from '../../../packages/node-data/src/index.js';",
      options: workspaceOption,
      errors: [{ messageId: 'projectPlatform' }],
    },
  ],
});

tester.run('no-bare-jsx-strings', noBareJsxStrings, {
  valid: [
    { code: "const page = <h1>{t('Hello')}</h1>;" },
    { code: "const page = <span>{count}{' '}</span>;" },
    { code: "const page = <div className='card'>{content}</div>;" },
  ],
  invalid: [
    {
      code: 'const page = <h1>Hello world</h1>;',
      errors: [{ messageId: 'bare' }],
    },
    {
      code: "const input = <input placeholder='Email address' />;",
      errors: [{ messageId: 'bare' }],
    },
    {
      code: "const page = <p>{'Welcome back'}</p>;",
      errors: [{ messageId: 'bare' }],
    },
  ],
});

describe('Megamono ESLint flat config', () => {
  it('maps repository severity overrides into the exported config', () => {
    const config = megamonoEslintPlugin.createConfig({
      conventions: {
        ...DEFAULT_MEGAMONO_CONFIG.conventions,
        rules: {
          'no-bare-jsx-strings': { severity: 'off' },
          'no-deep-relative-imports': { severity: 'warning' },
          'docs-visibility-boundary': { severity: 'warning' },
        },
      },
    });
    expect(config.rules?.['megamono/no-bare-jsx-strings']).toBe('off');
    expect(config.rules?.['megamono/no-deep-relative-imports']).toEqual([
      'warn',
      expect.objectContaining({ workspaceRoot: expect.any(String) }),
    ]);
    expect(config.rules?.['megamono/docs-visibility-boundary']).toEqual([
      'warn',
      expect.objectContaining({ workspaceRoot: expect.any(String) }),
    ]);
    expect(config.ignores).toContain(
      '**/eslint.config.{js,cjs,mjs,ts,cts,mts}',
    );
  });
});
