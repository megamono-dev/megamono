import type { ProjectGraph } from '@nx/devkit';
import { createRequire } from 'node:module';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectWorkspaceDependencies } from './workspace-dependency-health';

const roots: string[] = [];
const moduleApi = createRequire(import.meta.url)('node:module') as {
  _initPaths(): void;
};
afterEach(() => {
  vi.unstubAllEnvs();
  moduleApi._initPaths();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'megamono-dependency-health-')),
  );
  roots.push(root);
  return root;
}
function put(root: string, path: string, value: unknown) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}
function fixture() {
  const root = temporaryRoot();
  const graph: ProjectGraph = { nodes: {}, dependencies: {} };
  put(root, 'package.json', { name: '@fixture/source' });
  const project = (
    name: string,
    type: 'app' | 'lib',
    manifest?: Record<string, unknown>,
    directory = `${type === 'app' ? 'apps' : 'libs'}/${name}`,
  ) => {
    graph.nodes[name] = {
      name,
      type,
      data: {
        root: directory,
        tags: [
          type === 'app' ? 'type:app' : 'type:ui',
          'scope:fixture',
          'platform:web',
        ],
      },
    };
    graph.dependencies[name] = [];
    mkdirSync(join(root, directory), { recursive: true });
    if (manifest !== undefined)
      put(root, `${directory}/package.json`, manifest);
    return directory;
  };
  const edge = (
    source: string,
    target: string,
    type: 'static' | 'dynamic' | 'implicit' = 'static',
  ) => graph.dependencies[source].push({ source, target, type });
  return {
    root,
    graph,
    project,
    edge,
    inspect: () => inspectWorkspaceDependencies(root, graph),
  };
}
function installation(
  root: string,
  directory: string,
  name = 'react',
  version = '19.3.1',
) {
  put(root, `${directory}/package.json`, { name, version, main: 'index.js' });
  put(
    root,
    `${directory}/index.js`,
    'throw new Error("Inspected package code must never execute");\n',
  );
  return join(root, directory);
}
function link(root: string, owner: string, name: string, location: string) {
  const path = join(root, owner, 'node_modules', ...name.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(location, path, 'dir');
}

describe('workspace dependency health', () => {
  it('reports UI singletons a library declares as regular dependencies', () => {
    const f = fixture();
    f.project('ui', 'lib', {
      name: '@fixture/ui',
      dependencies: { '@chakra-ui/react': '3.37.0', react: '19.3.1' },
      peerDependencies: { react: '19.3.1' },
    });
    f.project('site', 'app', {
      name: '@fixture/site',
      dependencies: { '@chakra-ui/react': '3.37.0' },
    });
    const findings = f
      .inspect()
      .findings.filter(
        (finding) => finding.state === 'singleton-regular-dependency',
      );
    expect(findings).toEqual([
      expect.objectContaining({
        fingerprint: 'singleton-dependency:ui:@chakra-ui/react',
        evidence: [
          'libs/ui/package.json',
          'dependencies.@chakra-ui/react: 3.37.0',
        ],
      }),
    ]);
  });
  it('reports undeclared named runtime edges with helpful ownership guidance, not root hoisting', () => {
    const f = fixture();
    f.project('site', 'app', { name: '@fixture/site' });
    f.project('ui', 'lib', { name: '@fixture/ui' });
    put(f.root, 'package.json', {
      name: '@fixture/source',
      dependencies: { '@fixture/ui': 'workspace:*' },
    });
    f.edge('site', 'ui', 'static');
    f.edge('site', 'ui', 'dynamic');
    const result = f.inspect();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      state: 'undeclared-workspace-import',
      confidence: 'complete',
      check: 'dependency-alignment',
    });
    expect(result.findings[0].summary).toContain('@fixture/ui');
    expect(result.findings[0].recommendation).toContain(
      'hoisted root dependency',
    );
    expect(result.findings[0].evidence).toEqual(
      expect.arrayContaining([
        'apps/site/package.json',
        'dependency kinds: dynamic, static',
      ]),
    );
    expect(result.inspection?.packageEdges).toBe(1);
  });
  it.each([
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ])('accepts an explicit %s declaration', (section) => {
    const f = fixture();
    f.project('site', 'app', {
      name: '@fixture/site',
      [section]: { '@fixture/ui': 'workspace:*' },
    });
    f.project('ui', 'lib', { name: '@fixture/ui' });
    f.edge('site', 'ui');
    expect(f.inspect().findings).toEqual([]);
  });
  it('excludes implicit scheduling, unnamed classic projects and installed/Yalc graph copies', () => {
    const f = fixture();
    f.project('site', 'app', { name: '@fixture/site' });
    f.project('ui', 'lib', { name: '@fixture/ui' });
    f.project('classic', 'lib');
    f.project('unnamed', 'lib', {});
    f.project(
      'vendor',
      'lib',
      { name: '@fixture/vendor' },
      '.yalc/@fixture/vendor',
    );
    f.project(
      'installed',
      'lib',
      { name: '@fixture/installed' },
      'node_modules/@fixture/installed',
    );
    f.edge('site', 'ui', 'implicit');
    for (const target of ['classic', 'unnamed', 'vendor', 'installed'])
      f.edge('site', target);
    f.edge('classic', 'ui');
    f.edge('unnamed', 'ui');
    expect(f.inspect()).toEqual({ findings: [], inspection: undefined });
  });
  it.each(['{broken', '[]', JSON.stringify({ name: 42 })])(
    'reduces malformed manifest assessment without crashing: %s',
    (source) => {
      const f = fixture();
      const directory = f.project('site', 'app', { name: '@fixture/site' });
      f.project('ui', 'lib', { name: '@fixture/ui' });
      put(f.root, `${directory}/package.json`, source);
      f.edge('site', 'ui');
      const result = f.inspect();
      expect(result.findings).toEqual([]);
      expect(result.inspection?.limitations).toContain(
        'site: package.json could not be assessed',
      );
    },
  );
  it.each([[], 'broken', { '@fixture/ui': 4 }])(
    'reduces malformed dependency-section assessment instead of claiming an undeclared import: %j',
    (dependencies) => {
      const f = fixture();
      f.project('site', 'app', { name: '@fixture/site', dependencies });
      f.project('ui', 'lib', { name: '@fixture/ui' });
      f.edge('site', 'ui');
      const result = f.inspect();
      expect(result.findings).toEqual([]);
      expect(result.inspection?.limitations.length).toBeGreaterThan(0);
    },
  );
  it('does not follow external project or manifest symlinks into repository ownership', () => {
    const f = fixture();
    const outside = temporaryRoot();
    put(outside, 'package.json', { name: '@fixture/outside' });
    f.project('site', 'app', { name: '@fixture/site' });
    const manifestProject = f.project('manifest', 'lib');
    symlinkSync(
      join(outside, 'package.json'),
      join(f.root, manifestProject, 'package.json'),
    );
    f.graph.nodes.project = {
      name: 'project',
      type: 'lib',
      data: { root: 'libs/project' },
    };
    f.graph.dependencies.project = [];
    symlinkSync(outside, join(f.root, 'libs/project'), 'dir');
    f.edge('site', 'manifest');
    f.edge('site', 'project');
    const result = f.inspect();
    expect(result.findings).toEqual([]);
    expect(result.inspection?.limitations).toEqual(
      expect.arrayContaining([
        'manifest: manifest is outside repository ownership',
        'project: project root is outside repository ownership',
      ]),
    );
  });
  it.each(['react', '@chakra-ui/react', '@emotion/react'])(
    'detects different real installations of %s even at the same version without executing package code',
    (name) => {
      const f = fixture();
      const app = f.project('site', 'app', {
        name: '@fixture/site',
        dependencies: { [name]: '1.0.0', '@fixture/ui': 'workspace:*' },
      });
      const ui = f.project('ui', 'lib', {
        name: '@fixture/ui',
        peerDependencies: { [name]: '1.0.0' },
      });
      f.edge('site', 'ui');
      link(
        f.root,
        app,
        name,
        installation(f.root, `.store/first/${name}`, name, '1.0.0'),
      );
      link(
        f.root,
        ui,
        name,
        installation(f.root, `.store/second/${name}`, name, '1.0.0'),
      );
      const result = f.inspect();
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        state: 'multiple-installed-singletons',
        confidence: 'reduced',
      });
      expect(result.findings[0].recommendation).toContain(
        'not proof of duplicate browser code',
      );
      expect(result.inspection?.runtimeAssessment).toBe('not-assessed');
      expect(result.inspection?.singletons[0]).toMatchObject({
        application: 'site',
        package: name,
        status: 'multiple-installations',
        unavailable: [],
      });
      expect(
        new Set(
          result.inspection?.singletons[0].resolutions.map(
            (item) => item.installation,
          ),
        ).size,
      ).toBe(2);
    },
  );
  it('deduplicates symlinks to the same installation across static and dynamic closure projects', () => {
    const f = fixture();
    const app = f.project('site', 'app', {
      name: '@fixture/site',
      dependencies: { react: '19.3.1', '@fixture/ui': 'workspace:*' },
    });
    const ui = f.project('ui', 'lib', {
      name: '@fixture/ui',
      peerDependencies: { react: '19.3.1' },
      dependencies: { '@fixture/shared': 'workspace:*' },
    });
    const shared = f.project('shared', 'lib', {
      name: '@fixture/shared',
      devDependencies: { react: '19.3.1' },
    });
    f.edge('site', 'ui');
    f.edge('ui', 'shared', 'dynamic');
    const target = installation(f.root, '.store/shared-react');
    for (const owner of [app, ui, shared]) link(f.root, owner, 'react', target);
    const result = f.inspect();
    expect(result.findings).toEqual([]);
    expect(result.inspection?.singletons[0]).toMatchObject({
      status: 'single-installation',
      unavailable: [],
    });
    expect(result.inspection?.singletons[0].resolutions).toHaveLength(3);
  });
  it('keeps independent applications and scheduling-only projects out of each runtime comparison', () => {
    const f = fixture();
    const site = f.project('site', 'app', {
      name: '@fixture/site',
      dependencies: { react: '19.3.1' },
    });
    const mobile = f.project('mobile', 'app', {
      name: '@fixture/mobile',
      dependencies: { react: '18.3.1' },
    });
    const tools = f.project('tools', 'lib', {
      name: '@fixture/tools',
      devDependencies: { react: '1.0.0' },
    });
    f.edge('site', 'tools', 'implicit');
    link(
      f.root,
      site,
      'react',
      installation(f.root, '.store/web-react', 'react', '19.3.1'),
    );
    link(
      f.root,
      mobile,
      'react',
      installation(f.root, '.store/mobile-react', 'react', '18.3.1'),
    );
    link(
      f.root,
      tools,
      'react',
      installation(f.root, '.store/tool-react', 'react', '1.0.0'),
    );
    const result = f.inspect();
    expect(result.findings).toEqual([]);
    expect(
      result.inspection?.singletons.map((item) => [
        item.application,
        item.status,
      ]),
    ).toEqual([
      ['mobile', 'single-installation'],
      ['site', 'single-installation'],
    ]);
  });
  it('reports missing owned installs as incomplete even when ambient NODE_PATH can resolve the package', () => {
    const f = fixture();
    const app = f.project('site', 'app', {
      name: '@fixture/site',
      dependencies: { react: '19.3.1' },
    });
    const outside = temporaryRoot();
    installation(outside, 'node_modules/react');
    vi.stubEnv('NODE_PATH', join(outside, 'node_modules'));
    moduleApi._initPaths();
    expect(
      createRequire(join(f.root, app, 'package.json')).resolve('react'),
    ).toContain(outside);
    const result = f.inspect();
    expect(result.findings).toEqual([]);
    expect(result.inspection?.singletons[0]).toMatchObject({
      status: 'incomplete',
      resolutions: [],
      unavailable: ['site'],
    });
    expect(result.inspection?.limitations[0]).toContain('no ambient fallback');
  });
  it('fails resolution closed for escaping package entries and malformed installed manifests', () => {
    const f = fixture();
    const app = f.project('site', 'app', {
      name: '@fixture/site',
      dependencies: { react: '19.3.1' },
    });
    const installed = installation(f.root, '.store/react');
    put(f.root, '.store/react/package.json', {
      name: 'react',
      version: '19.3.1',
      main: '../../escape.js',
    });
    put(f.root, `${app}/escape.js`, 'throw new Error("Do not execute");');
    link(f.root, app, 'react', installed);
    expect(
      createRequire(join(f.root, app, 'package.json')).resolve('react'),
    ).toBe(join(f.root, app, 'escape.js'));
    expect(f.inspect().inspection?.singletons[0].status).toBe('incomplete');
    put(f.root, '.store/react/package.json', '{broken');
    expect(f.inspect().inspection?.singletons[0].status).toBe('incomplete');
  });
  it('reports stable ordering for equivalent shuffled graph objects and edges', () => {
    const f = fixture();
    f.project('z', 'app', { name: '@fixture/z' });
    f.project('a', 'lib', { name: '@fixture/a' });
    f.project('b', 'lib', { name: '@fixture/b' });
    f.edge('z', 'b', 'dynamic');
    f.edge('z', 'a');
    const before = f.inspect();
    f.graph.nodes = Object.fromEntries(Object.entries(f.graph.nodes).reverse());
    f.graph.dependencies = Object.fromEntries(
      Object.entries(f.graph.dependencies).reverse(),
    );
    f.graph.dependencies.z.reverse();
    expect(f.inspect()).toEqual(before);
    expect(readFileSync(join(f.root, 'package.json'), 'utf8')).toContain(
      '@fixture/source',
    );
  });
});
