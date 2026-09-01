import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfiguration } from '@nx/devkit';
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
});
