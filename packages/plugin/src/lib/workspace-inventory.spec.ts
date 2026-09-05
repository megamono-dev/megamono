import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { createWorkspaceInventory } from './workspace-inventory';
import { classifyProjectForAdoption } from './project-adoption';

describe('mixed application inventory', () => {
  it('distinguishes Figma, WXT, generic extensions and unrelated manifests', () => {
    const tree = createTreeWithEmptyWorkspace();
    const fixtures = [
      [
        'figma',
        'manifest.json',
        JSON.stringify({
          name: 'Design',
          main: 'code.js',
          api: '1.0.0',
          editorType: ['figma'],
        }),
      ],
      ['wxt', 'wxt.config.ts', 'export default {};'],
      [
        'browser-extension',
        'public/manifest.json',
        JSON.stringify({ name: 'Tools', manifest_version: 3 }),
      ],
      [
        'unrelated',
        'manifest.json',
        JSON.stringify({ name: 'Web app', display: 'standalone' }),
      ],
    ];
    const files: string[] = [];
    const projects = new Map(
      fixtures.map(([name, file, content]) => {
        const root = `apps/${name}`;
        files.push(`${root}/${file}`);
        tree.write(`${root}/${file}`, content);
        return [name, { root }];
      }),
    );
    const inventory = createWorkspaceInventory(tree, projects, files);
    for (const [name, project] of projects) {
      const classified = classifyProjectForAdoption(tree, name, project);
      expect(classified.platform).toBe(
        name === 'unrelated' ? undefined : 'extension',
      );
      expect(
        inventory.projects
          .find((item) => item.name === name)
          ?.frameworks.map(({ value }) => value),
      ).toEqual(name === 'unrelated' ? [] : [name]);
    }
  });

  it('retains Node for a Nest API hosting workers and inventories both router modes', () => {
    const tree = createTreeWithEmptyWorkspace();
    const contents = {
      'apps/api/package.json': JSON.stringify({
        dependencies: { '@nestjs/core': '11.0.0', bullmq: '6.0.0' },
      }),
      'apps/api/src/app.ts': `import { Controller } from '@nestjs/common';
        import { Processor, WorkerHost } from '@nestjs/bullmq';
        @Controller('jobs') class Api {}
        @Processor('jobs') class Jobs extends WorkerHost {}`,
      'apps/site/next.config.js': 'module.exports = {};',
      'apps/site/src/pages/index.tsx': 'export default () => null;',
      'apps/site/src/app/page.tsx': 'export default () => null;',
    };
    for (const [path, content] of Object.entries(contents))
      tree.write(path, content);
    const projects = new Map([
      ['api', { root: 'apps/api' }],
      ['site', { root: 'apps/site' }],
    ]);
    const inventory = createWorkspaceInventory(
      tree,
      projects,
      Object.keys(contents),
    );
    expect(inventory.projects.find(({ name }) => name === 'api')).toMatchObject(
      { roles: ['api', 'worker'], serviceKinds: ['queue'] },
    );
    expect(
      classifyProjectForAdoption(tree, 'api', { root: 'apps/api' }).platform,
    ).toBe('node');
    expect(
      inventory.projects.find(({ name }) => name === 'site'),
    ).toMatchObject({ nextRouter: 'mixed' });
  });
});
