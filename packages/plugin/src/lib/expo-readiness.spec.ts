import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProjectGraph, TargetConfiguration } from '@nx/devkit';
import { DEFAULT_MEGAMONO_CONFIG } from './config';
import { expoReadinessFindings, inspectExpoProjects } from './expo-readiness';
import { runRepositoryHealth } from './health';

describe('Expo platform inspection', () => {
  let root: string;
  const write = (path: string, value: unknown) => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(
      absolute,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  const graph = (
    targets: Record<string, TargetConfiguration> = {},
  ): ProjectGraph => ({
    nodes: {
      mobile: {
        name: 'mobile',
        type: 'app',
        data: { root: 'apps/mobile', targets },
      },
      web: { name: 'web', type: 'app', data: { root: 'apps/web' } },
    },
    dependencies: { mobile: [], web: [] },
  });
  const app = (manifest: Record<string, unknown> = {}) => {
    write('apps/mobile/package.json', {
      name: '@acme/mobile',
      dependencies: { expo: '~54.0.37' },
      ...manifest,
    });
  };
  const install = (
    name: string,
    manifest: Record<string, unknown>,
    prefix = 'apps/mobile',
  ) =>
    write(`${prefix}/node_modules/${name}/package.json`, { name, ...manifest });
  const inspect = (targets?: Record<string, TargetConfiguration>) =>
    inspectExpoProjects(root, graph(targets));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'megamono-expo-health-'));
    write('package.json', {
      dependencies: { expo: '~54.0.37', react: '19.3.0' },
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('does not classify unrelated projects or command mentions as Expo apps', () => {
    write('apps/mobile/package.json', { scripts: { note: 'echo expo' } });
    expect(inspect({ build: { command: 'echo expo export' } })).toEqual([]);
  });

  it('reports declared and installed SDK separately without executing config', () => {
    write('apps/mobile/package.json', { name: '@acme/mobile' });
    write('apps/mobile/app.json', { expo: { sdkVersion: '54.0.0' } });
    write('apps/mobile/app.config.js', "throw new Error('must not execute')");
    install('expo', { version: '54.0.37' });
    expect(inspect()[0]).toMatchObject({
      declaredExpoRange: '~54.0.37',
      installedExpoVersion: '54.0.37',
      configuredSdkVersion: '54.0.0',
      validation: 'not-assessed',
      metro: { status: 'implicit-defaults' },
    });
  });

  it('recognizes explicit Nx Expo targets without a static app.json', () => {
    install('expo', { version: '54.0.37' });
    expect(inspect({ export: { executor: '@nx/expo:export' } })).toHaveLength(
      1,
    );
  });

  it('does not mistake documentation, help, or an unrelated root check for Doctor configuration', () => {
    app({
      scripts: {
        note: 'echo expo-doctor',
        help: 'npx expo-doctor --help',
        fake: 'node check-expo-doctor.js',
      },
    });
    write('package.json', {
      scripts: {
        doctor: 'npx expo-doctor',
        other: 'npm exec --workspace=@acme/other -- expo-doctor',
      },
    });
    expect(inspect()[0].doctor.status).toBe('not-detected');
  });

  it('recognizes app-scoped scripts and targets but never claims they passed', () => {
    app({ scripts: { doctor: 'npm exec -- expo-doctor' } });
    write('package.json', {
      scripts: { mobile: 'npm exec --workspace=@acme/mobile -- expo-doctor' },
    });
    install('expo-doctor', { version: '1.21.6', engines: { node: '>=18' } });
    const [result] = inspect({
      'expo-doctor': { executor: '@megamono/plugin:expo-doctor' },
    });
    expect(result.doctor).toEqual({
      status: 'configured',
      installedVersion: '1.21.6',
      nodeRange: '>=18',
      nodeCompatible: true,
      evidence: [
        'apps/mobile/package.json#scripts.doctor',
        'mobile:target:expo-doctor',
        'package.json#scripts.mobile',
      ],
    });
    expect(result.validation).toBe('not-assessed');
  });

  it('requires an app cwd before recognizing direct run-command targets', () => {
    app();
    expect(
      inspect({
        doctor: {
          executor: 'nx:run-commands',
          options: { command: 'expo-doctor' },
        },
      })[0].doctor.status,
    ).toBe('not-detected');
    expect(
      inspect({
        doctor: {
          executor: 'nx:run-commands',
          options: {
            commands: [{ command: 'pnpm exec expo-doctor' }],
            cwd: '{projectRoot}',
          },
        },
      })[0].doctor.status,
    ).toBe('configured');
  });

  it('does not execute Metro and ignores commented imports or string mentions', () => {
    app();
    const source = `// require('expo/metro-config')\nconst note = "require('expo/metro-config')";\nthrow new Error('not executed');`;
    write('apps/mobile/metro.config.js', source);
    const results = inspect();
    expect(results[0].metro.status).toBe('custom-unverified');
    expect(
      readFileSync(join(root, 'apps/mobile/metro.config.js'), 'utf8'),
    ).toBe(source);
  });

  it('accepts Expo defaults composed with Nx and calls internal imports out for review', () => {
    app();
    write(
      'apps/mobile/metro.config.js',
      "const { getDefaultConfig } = require('expo/metro-config'); const { withNxMetro } = require('@nx/expo'); module.exports = withNxMetro(getDefaultConfig(__dirname));",
    );
    expect(inspect()[0].metro.status).toBe('expo-defaults-import');
    write(
      'apps/mobile/metro.config.js',
      "import {getDefaultConfig} from '@expo/metro-config'; export default getDefaultConfig(import.meta.dirname);",
    );
    expect(expoReadinessFindings(inspect())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fingerprint: 'expo:metro-internal-import:mobile',
          confidence: 'reduced',
        }),
      ]),
    );
  });

  it('checks the installed SDK against app-local React without aligning web React', () => {
    app();
    install('expo', { version: '54.0.37' });
    write('apps/mobile/node_modules/expo/bundledNativeModules.json', {
      react: '19.1.0',
      'react-dom': '19.1.0',
      'react-native': '0.81.5',
    });
    install('react', { version: '19.1.0' });
    install('react-native', { version: '0.81.5' });
    install('react', { version: '19.3.0' }, '.');
    install('react-dom', { version: '19.3.0' }, '.');
    const [result] = inspect();
    expect(result.compatibility).toEqual([
      {
        package: 'react',
        expected: '19.1.0',
        installed: '19.1.0',
        compatible: true,
      },
      {
        package: 'react-native',
        expected: '0.81.5',
        installed: '0.81.5',
        compatible: true,
      },
    ]);
    expect(
      expoReadinessFindings([result]).some(({ fingerprint }) =>
        /sdk-react/.test(fingerprint),
      ),
    ).toBe(false);
    install('react', { version: '19.3.0' });
    expect(expoReadinessFindings(inspect())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fingerprint: 'expo:sdk-react:mobile',
          confidence: 'complete',
        }),
      ]),
    );
  });

  it('reports missing Doctor installations and incompatible runtime requirements', () => {
    app({ scripts: { doctor: 'expo-doctor' } });
    expect(
      expoReadinessFindings(inspect()).map(({ fingerprint }) => fingerprint),
    ).toContain('expo:doctor-unavailable:mobile');
    install('expo-doctor', { version: '1.21.6', engines: { node: '>=99' } });
    expect(
      expoReadinessFindings(inspect()).map(({ fingerprint }) => fingerprint),
    ).toContain('expo:doctor-node:mobile');
  });

  it('reports configured SDK major conflicts without comparing SDK patch to the Expo patch', () => {
    app();
    install('expo', { version: '54.0.37' });
    write('apps/mobile/app.json', { expo: { sdkVersion: '54.0.0' } });
    expect(
      expoReadinessFindings(inspect()).map(({ fingerprint }) => fingerprint),
    ).not.toContain('expo:sdk-config:mobile');
    write('apps/mobile/app.json', { expo: { sdkVersion: '53.0.0' } });
    expect(
      expoReadinessFindings(inspect()).map(({ fingerprint }) => fingerprint),
    ).toContain('expo:sdk-config:mobile');
  });

  it('includes Expo evidence in health without docs adoption while preserving advisory semantics', async () => {
    app();
    const result = await runRepositoryHealth({
      workspaceRoot: root,
      graph: graph(),
      documents: [],
      checks: ['spec-drift'],
      config: {
        ...DEFAULT_MEGAMONO_CONFIG,
        adoption: { ...DEFAULT_MEGAMONO_CONFIG.adoption, modules: ['health'] },
      },
    });
    expect(result.purpose).toBe('advisory');
    expect(result.readiness).toBe('not-assessed');
    expect(result.platforms?.expo[0].validation).toBe('not-assessed');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fingerprint: 'expo:doctor-not-detected:mobile',
          check: 'spec-drift',
        }),
      ]),
    );
    expect(result.coverage['spec-drift'].status).toBe('partial');
  });
});
