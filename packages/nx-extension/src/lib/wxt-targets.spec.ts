import { readJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { extensionApplicationGenerator } from '../generators/application/application';
import { projectsFromWxtConfigs } from './extension';

describe('shared WXT scheduling', () => {
  it('uses the same serial finite DAG for authored and inferred targets', async () => {
    const tree = createTreeWithEmptyWorkspace();
    await extensionApplicationGenerator(tree, {
      name: 'browser',
      scope: 'fixture',
      manifestVersion: 3,
      skipFormat: true,
    });
    const authored = readJson(tree, 'apps/browser/project.json').targets;
    const inferred = projectsFromWxtConfigs([
      {
        configPath: 'apps/browser/wxt.config.ts',
        root: 'apps/browser',
        projectName: 'fixture-browser',
        tags: [],
        storeCommands: {},
        browserManifestVersions: { chrome: 3, firefox: 3 },
      },
    ])['apps/browser'].targets;
    expect(authored).toEqual(inferred);
    const chain = [
      'prepare',
      'typecheck',
      'build-chrome',
      'build-firefox',
      'package-chrome',
      'package-firefox',
      'package-firefox-source',
    ];
    for (const [index, target] of chain.entries()) {
      expect(authored[target].cache).toBe(false);
      expect(authored[target].dependsOn).toEqual(
        index ? [chain[index - 1]] : [],
      );
    }
    expect(authored.prepare.outputs).toEqual(['{projectRoot}/.wxt']);
    expect(authored.typecheck.options.command).toBe('tsc --noEmit');
  });
});
