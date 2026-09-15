import { writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  EXTENSION_TOOLCHAIN,
  extensionTypeScript,
  verifyExtensionToolchain,
} from './toolchain';

const fixtures: string[] = [];
afterEach(() =>
  fixtures
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const json = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};

describe('extension toolchain selection and verification', () => {
  it.each(['5.9.3', '~5.9.3', '~6.0.3'])(
    'preserves repository TypeScript %s without rewriting it',
    (typescript) => {
      const tree = createTreeWithEmptyWorkspace();
      writeJson(tree, 'package.json', { devDependencies: { typescript } });
      const before = tree.listChanges();
      expect(extensionTypeScript(tree)).toBe(typescript);
      expect(tree.listChanges()).toEqual(before);
    },
  );
  it.each(['^5.0.0', '*', 'catalog:', 'workspace:*', '^7.0.0'])(
    'rejects unreviewed TypeScript %s',
    (typescript) => {
      const tree = createTreeWithEmptyWorkspace();
      writeJson(tree, 'package.json', { devDependencies: { typescript } });
      expect(() => extensionTypeScript(tree)).toThrow('reviewed TypeScript');
    },
  );
  it('checks resolved required and present optional peers without executing package code', () => {
    const root = mkdtempSync(join(tmpdir(), 'extension-peers-'));
    fixtures.push(root);
    const dependencies = { ...EXTENSION_TOOLCHAIN, typescript: '5.9.3' };
    json(join(root, 'package.json'), { devDependencies: dependencies });
    for (const [name, version] of Object.entries(dependencies)) {
      json(join(root, 'node_modules', name, 'package.json'), {
        name,
        version,
        main: './index.js',
      });
      writeFileSync(
        join(root, 'node_modules', name, 'index.js'),
        'throw Error("must not execute")',
      );
    }
    json(join(root, 'node_modules/vite/package.json'), {
      name: 'vite',
      version: EXTENSION_TOOLCHAIN.vite,
      peerDependencies: { esbuild: '^0.27.0 || ^0.28.0', optional: '^1.0.0' },
      peerDependenciesMeta: {
        esbuild: { optional: true },
        optional: { optional: true },
      },
    });
    expect(() => verifyExtensionToolchain(root)).not.toThrow();
    json(join(root, 'node_modules/esbuild/package.json'), {
      name: 'esbuild',
      version: '0.25.0',
    });
    expect(() => verifyExtensionToolchain(root)).toThrow('peer esbuild');
    json(join(root, 'node_modules/esbuild/package.json'), {
      name: 'esbuild',
      version: EXTENSION_TOOLCHAIN.esbuild,
    });
    const physical = join(root, 'node_modules/.pnpm/wxt/node_modules/wxt');
    json(join(physical, 'package.json'), {
      name: 'wxt',
      version: EXTENSION_TOOLCHAIN.wxt,
      peerDependencies: { vite: '^8.0.0' },
    });
    json(join(physical, '../vite/package.json'), {
      name: 'vite',
      version: '8.1.4',
    });
    rmSync(join(root, 'node_modules/wxt'), { recursive: true });
    symlinkSync(physical, join(root, 'node_modules/wxt'), 'dir');
    expect(() => verifyExtensionToolchain(root)).toThrow(
      'differs from the selected app-local version',
    );
  });
});
