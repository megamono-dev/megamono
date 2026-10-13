import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfiguration } from '@nx/devkit';
import { globWithWorkspaceContext } from 'nx/src/utils/workspace-context';
import { createNodesV2 } from '../index';
import {
  createNodes,
  projectsFromWxtConfigs,
  type WxtConfigRecord,
} from './extension';

function record(overrides: Partial<WxtConfigRecord> = {}): WxtConfigRecord {
  return {
    configPath: 'apps/extension/wxt.config.ts',
    root: 'apps/extension',
    projectName: 'fixture-extension',
    packageName: '@fixture/extension',
    tags: ['platform:extension', 'scope:fixture', 'type:app'],
    storeCommands: {},
    ...overrides,
  };
}

describe('WXT project inference', () => {
  it('exports the transitional discovery hook required by Nx 21', () => {
    expect(createNodesV2).toBe(createNodes);
  });
  it('discovers every supported source filename with the native Nx glob parser', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nx-extension-glob-'));
    const filenames = [
      'wxt.config.ts',
      'wxt.config.js',
      'wxt.config.mjs',
      'wxt.config.mts',
      'manifest.json',
      'manifest.chrome.json',
      'manifest.firefox.json',
      'package.json',
    ];
    try {
      await mkdir(join(root, 'apps/extension'), { recursive: true });
      for (const filename of [...filenames, 'unrelated.json'])
        await writeFile(join(root, 'apps/extension', filename), '{}');
      expect(
        (await globWithWorkspaceContext(root, [createNodes[0]])).sort(),
      ).toEqual(
        filenames.map((filename) => `apps/extension/${filename}`).sort(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([2, 3] as const)(
    'binds all inferred commands to the project and respects Firefox MV%s',
    (version) => {
      const project = projectsFromWxtConfigs([
        record({ browserManifestVersions: { firefox: version } }),
      ])['apps/extension'];
      for (const target of Object.values(project.targets ?? {}))
        if (target.executor === 'nx:run-commands')
          expect(target.options?.cwd).toBe('{projectRoot}');
      expect(project.targets?.['build-firefox'].options?.command).toBe(
        `wxt build --browser firefox --mv${version}`,
      );
      expect(project.targets?.['build-firefox'].outputs).toEqual([
        `{projectRoot}/.output/firefox-mv${version}`,
      ]);
      expect(project.targets?.['dev-firefox'].options?.command).toContain(
        `--mv${version}`,
      );
      expect(
        project.targets?.['package-firefox-source'].options?.command,
      ).toContain(`--mv${version} --sources`);
    },
  );

  it('does not assume a version when WXT config owns the decision', () => {
    const project = projectsFromWxtConfigs([record()])['apps/extension'];
    expect(project.targets?.['build-firefox'].outputs).toEqual([
      '{projectRoot}/.output/firefox-mv*',
    ]);
    expect(project.targets?.['build-firefox'].options?.command).toBe(
      'wxt build --browser firefox',
    );
  });

  it('groups browser-specific source manifests and preserves Vite scripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nx-extension-browsers-'));
    const files = [
      'apps/extension/manifest.chrome.json',
      'apps/extension/manifest.firefox.json',
      'apps/extension/dist/manifest.json',
    ];
    await mkdir(join(root, 'apps/extension/dist'), { recursive: true });
    await writeFile(
      join(root, 'apps/extension/package.json'),
      JSON.stringify({
        name: '@fixture/extension',
        scripts: { build: 'vite build' },
      }),
    );
    for (const path of files)
      await writeFile(
        join(root, path),
        JSON.stringify({
          manifest_version: 3,
          name: 'Fixture',
          version: '1.0.0',
        }),
      );
    const callback = createNodes[1] as unknown as (
      files: string[],
      options: object,
      context: { workspaceRoot: string },
    ) => Promise<
      readonly (readonly [
        unknown,
        { projects: Record<string, ProjectConfiguration> },
      ])[]
    >;
    const results = await callback(files, {}, { workspaceRoot: root });
    expect(results).toHaveLength(1);
    const project = results[0][1].projects['apps/extension'];
    expect(project.targets).toEqual({
      build: {
        executor: 'nx:run-script',
        cache: true,
        options: { script: 'build' },
      },
    });
    expect(project.metadata?.['megamono:extension']).toMatchObject({
      manifestPaths: files.slice(0, 2),
    });
  });

  it('accepts explicit package-relative manifests and rejects escaping paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nx-extension-configured-'));
    await mkdir(join(root, 'apps/extension/config'), { recursive: true });
    const path = 'apps/extension/package.json';
    await writeFile(
      join(root, path),
      JSON.stringify({
        name: '@fixture/extension',
        megamono: { extension: { manifests: ['config/browser.json'] } },
      }),
    );
    await writeFile(
      join(root, 'apps/extension/config/browser.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Fixture',
        version: '1.0.0',
      }),
    );
    const callback = createNodes[1] as unknown as (
      file: string,
      options: object,
      context: { workspaceRoot: string },
    ) => Promise<{ projects: Record<string, ProjectConfiguration> }>;
    expect(
      (await callback(path, {}, { workspaceRoot: root })).projects[
        'apps/extension'
      ],
    ).toBeDefined();
    await writeFile(
      join(root, path),
      JSON.stringify({
        megamono: { extension: { manifests: ['../outside.json'] } },
      }),
    );
    await expect(callback(path, {}, { workspaceRoot: root })).rejects.toThrow(
      'package-relative',
    );
  });

  it('emits distinct browser build and package targets', () => {
    const projects = projectsFromWxtConfigs([record()]);
    const project = projects['apps/extension'];

    expect(project).toMatchObject({
      name: 'fixture-extension',
      projectType: 'application',
      tags: expect.arrayContaining(['platform:extension']),
    });
    expect(project.targets?.build.dependsOn).toEqual([
      'build-chrome',
      'build-firefox',
    ]);
    expect(project.targets?.package.dependsOn).toEqual([
      'package-chrome',
      'package-firefox',
      'package-firefox-source',
    ]);
    expect(project.targets?.['build-chrome'].outputs).not.toEqual(
      project.targets?.['build-firefox'].outputs,
    );
    expect(project.metadata?.['megamono:extension']).toMatchObject({
      safari: 'separate-apple-project',
    });
  });

  it('adds non-cacheable deploy targets only for explicit store commands', () => {
    const project = projectsFromWxtConfigs([
      record({
        storeCommands: {
          chrome: 'node tools/publish-chrome.mjs',
          firefox: 'node tools/publish-firefox.mjs',
        },
      }),
    ])['apps/extension'];

    expect(project.targets?.deploy).toMatchObject({
      cache: false,
      dependsOn: ['deploy-chrome', 'deploy-firefox'],
    });
    expect(project.targets?.['deploy-chrome']).toMatchObject({ cache: false });
  });

  it('can represent a hand-authored WXT project root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nx-extension-'));
    await mkdir(join(root, 'apps/extension'), { recursive: true });
    await writeFile(
      join(root, 'apps/extension/wxt.config.ts'),
      'export default {};',
    );
    await writeFile(
      join(root, 'apps/extension/package.json'),
      JSON.stringify({ name: '@fixture/extension' }),
    );
    const callback = createNodes[1] as unknown as (
      configFile: string,
      options: Record<string, never>,
      context: { workspaceRoot: string },
    ) => Promise<{ projects: Record<string, ProjectConfiguration> }>;
    const result = await callback(
      'apps/extension/wxt.config.ts',
      {},
      {
        workspaceRoot: root,
      },
    );

    expect(result.projects['apps/extension']).toMatchObject({
      name: '@fixture/extension',
      root: 'apps/extension',
      projectType: 'application',
    });
  });

  it('infers a non-WXT browser extension from its standard manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nx-extension-manifest-'));
    await mkdir(join(root, 'apps/extension/public'), { recursive: true });
    await writeFile(
      join(root, 'apps/extension/public/manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Fixture',
        version: '1.0.0',
      }),
    );
    await writeFile(
      join(root, 'apps/extension/package.json'),
      JSON.stringify({
        name: '@fixture/hand-authored-extension',
        scripts: { build: 'vite build', dev: 'vite' },
      }),
    );
    const callback = createNodes[1] as unknown as (
      configFile: string,
      options: Record<string, never>,
      context: { workspaceRoot: string },
    ) => Promise<{ projects: Record<string, ProjectConfiguration> }>;

    const result = await callback(
      'apps/extension/public/manifest.json',
      {},
      { workspaceRoot: root },
    );

    expect(result.projects['apps/extension']).toMatchObject({
      name: '@fixture/hand-authored-extension',
      projectType: 'application',
      tags: expect.arrayContaining(['platform:extension']),
      targets: {
        build: { executor: 'nx:run-script', options: { script: 'build' } },
        dev: {
          executor: 'nx:run-script',
          continuous: true,
          options: { script: 'dev' },
        },
      },
      metadata: {
        technologies: ['webextension'],
        'megamono:extension': {
          framework: 'manifest',
          manifestVersion: 3,
        },
      },
    });
  });
});
