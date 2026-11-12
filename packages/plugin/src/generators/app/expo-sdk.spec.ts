import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { createHash } from 'node:crypto';
import { satisfies } from 'semver';
import compatibility from '../../../compatibility.json';
import { selectExpoSdk, type ExpoSdkRegistry } from './expo-sdk';

const registry = compatibility.expoSdks as ExpoSdkRegistry;
const names = Object.keys(registry.snapshots[57].requirements);

describe('published Expo SDK metadata selection', () => {
  it('does not treat an ambient SDK without a workspace owner as the default policy', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'node_modules/expo/package.json',
      '{"name":"expo","version":"54.0.38"}',
    );
    tree.write(
      'node_modules/expo/bundledNativeModules.json',
      JSON.stringify(registry.snapshots[54].requirements),
    );
    expect(selectExpoSdk(tree, registry, undefined, names, []).version).toBe(
      '57.0.32',
    );
  });
  it('selects the exact reviewed default and its real Native peer requirement', () => {
    const tree = createTreeWithEmptyWorkspace();
    const before = tree.listChanges();
    const sdk = selectExpoSdk(tree, registry, undefined, names);
    expect(sdk).toMatchObject({
      version: '57.0.32',
      declaration: '57.0.32',
      source: 'verified-snapshot',
      requirements: {
        react: '19.2.3',
        'react-dom': '19.2.3',
        'react-native': '0.86.3',
        'react-native-svg': '15.15.4',
        '@types/react': '~19.2.0',
        'babel-preset-expo': '~57.0.17',
      },
    });
    expect(
      satisfies(
        sdk.requirements.react,
        registry.snapshots[57].reactNativePeerReact.range,
      ),
    ).toBe(true);
    expect(
      satisfies('19.2.0', registry.snapshots[57].reactNativePeerReact.range),
    ).toBe(false);
    expect(tree.listChanges()).toEqual(before);
  });

  it.each(['54.0.38', '~54.0.38', '^54.0.38', '>=54.0.38 <55'])(
    'preserves an explicit SDK declaration when the snapshot satisfies it: %s',
    (declaration) => {
      const sdk = selectExpoSdk(
        createTreeWithEmptyWorkspace(),
        registry,
        declaration,
        names,
      );
      expect(sdk.declaration).toBe(declaration);
      expect(sdk.version).toBe('54.0.38');
      expect(sdk.requirements.react).toBe('19.1.0');
    },
  );

  it('retains an explicitly authored previous patch when its metadata is installed', () => {
    const tree = createTreeWithEmptyWorkspace();
    const requirements = {
      ...registry.snapshots[57].requirements,
      '@expo/cli': '^57.0.32',
      '@expo/metro-config': '~57.0.13',
      '@expo/metro-runtime': '~57.0.17',
      'babel-preset-expo': '~57.0.16',
      'expo-splash-screen': '~57.0.10',
    };
    tree.write(
      'node_modules/expo/package.json',
      JSON.stringify({ name: 'expo', version: '57.0.31' }),
    );
    tree.write(
      'node_modules/expo/bundledNativeModules.json',
      JSON.stringify(requirements),
    );
    const before = tree.listChanges();
    expect(selectExpoSdk(tree, registry, '57.0.31', names)).toMatchObject({
      version: '57.0.31',
      declaration: '57.0.31',
      source: 'installed',
      requirements,
    });
    expect(tree.listChanges()).toEqual(before);
  });

  it('requires installed metadata for an older exact patch instead of upgrading it', () => {
    const tree = createTreeWithEmptyWorkspace();
    const before = tree.listChanges();
    expect(() => selectExpoSdk(tree, registry, '57.0.31', names)).toThrow(
      'no matching installed metadata or verified snapshot',
    );
    expect(tree.listChanges()).toEqual(before);
  });

  it.each(['53', '54', '55', '56', '57'])(
    'records reproducible public metadata provenance for SDK%s',
    (major) => {
      const snapshot = registry.snapshots[major];
      const ordered = Object.fromEntries(
        Object.entries(snapshot.requirements).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
      expect(
        createHash('sha256').update(JSON.stringify(ordered)).digest('hex'),
      ).toBe(snapshot.requirementsSha256);
      expect(snapshot.source.tarball).toBe(
        `https://registry.npmjs.org/expo/-/expo-${snapshot.version}.tgz`,
      );
      expect(snapshot.source.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
      expect(snapshot.source.bundledNativeModulesSha256).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(snapshot.source.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
      const selected = selectExpoSdk(
        createTreeWithEmptyWorkspace(),
        registry,
        snapshot.version,
        names,
      );
      expect(
        satisfies(
          selected.requirements.react,
          snapshot.reactNativePeerReact.range,
        ),
      ).toBe(true);
    },
  );

  it('prefers matching installed public metadata without executing an SDK module', () => {
    const tree = createTreeWithEmptyWorkspace();
    const requirements = registry.snapshots[54].requirements;
    tree.write(
      'node_modules/expo/package.json',
      JSON.stringify({
        name: 'expo',
        version: '54.0.39',
        main: 'never-execute.js',
        dependencies: {
          '@expo/cli': requirements['@expo/cli'],
          'babel-preset-expo': requirements['babel-preset-expo'],
        },
        devDependencies: { '@types/react': requirements['@types/react'] },
      }),
    );
    tree.write(
      'node_modules/expo/never-execute.js',
      "throw new Error('SDK code must not execute');",
    );
    tree.write(
      'node_modules/expo/bundledNativeModules.json',
      JSON.stringify({ ...requirements, 'react-native-svg': '15.12.2' }),
    );
    const before = tree.listChanges();
    const selected = selectExpoSdk(tree, registry, '~54.0.38', names);
    expect(selected).toMatchObject({
      version: '54.0.39',
      declaration: '~54.0.38',
      source: 'installed',
      requirements: { 'react-native-svg': '15.12.2' },
    });
    expect(tree.listChanges()).toEqual(before);
  });

  it('does not substitute a snapshot for an unsupported exact SDK or conflicting installed major', () => {
    const tree = createTreeWithEmptyWorkspace();
    expect(() => selectExpoSdk(tree, registry, '54.0.1', names)).toThrow(
      'no matching installed metadata',
    );
    tree.write(
      'node_modules/expo/package.json',
      '{"name":"expo","version":"55.0.32"}',
    );
    tree.write(
      'node_modules/expo/bundledNativeModules.json',
      JSON.stringify(registry.snapshots[55].requirements),
    );
    expect(() => selectExpoSdk(tree, registry, '~54.0.38', names)).toThrow(
      'conflicts with selected SDK',
    );
  });

  it('rejects snapshot requirement drift before writing anything', () => {
    const tree = createTreeWithEmptyWorkspace();
    const changed = {
      ...registry,
      snapshots: {
        ...registry.snapshots,
        57: {
          ...registry.snapshots[57],
          requirements: {
            ...registry.snapshots[57].requirements,
            react: '19.2.0',
          },
        },
      },
    };
    const before = tree.listChanges();
    expect(() => selectExpoSdk(tree, changed, undefined, names)).toThrow(
      'matching provenance',
    );
    expect(tree.listChanges()).toEqual(before);
  });
});
