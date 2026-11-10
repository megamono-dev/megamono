import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  addProjectConfiguration,
  readProjectConfiguration,
  readJson,
  writeJson,
} from '@nx/devkit';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  configureNextRuntime,
  nextServerSource,
  prepareNextInference,
} from './web-runtime';

describe('Next.js runtime contract', () => {
  it('keeps the legacy path on Nx 17', () => {
    const tree = createTreeWithEmptyWorkspace();
    writeJson(tree, 'package.json', { devDependencies: { nx: '17.1.2' } });
    expect(prepareNextInference(tree, 'apps/site')).toBe(false);
  });
  it('rejects target-name collisions before registering inference', () => {
    const tree = createTreeWithEmptyWorkspace();
    writeJson(tree, 'nx.json', {
      plugins: [
        { plugin: '@nx/next/plugin', options: { devTargetName: 'build' } },
      ],
    });
    expect(() => prepareNextInference(tree, 'apps/site')).toThrow(
      'distinct nonempty names',
    );
  });
  it('preserves an explicitly named static serve target', () => {
    const tree = createTreeWithEmptyWorkspace();
    writeJson(tree, 'nx.json', {
      plugins: [
        {
          plugin: '@nx/next/plugin',
          options: { serveStaticTargetName: 'serve' },
        },
      ],
    });
    addProjectConfiguration(tree, 'site', {
      root: 'apps/site',
      targets: { serve: { command: 'next start' } },
    });
    configureNextRuntime(tree, 'site', 'apps/site', 45000);
    expect(readProjectConfiguration(tree, 'site').targets?.serve).toEqual({
      command: 'next start',
    });
  });
  it('scopes new inference without enrolling existing Next applications', () => {
    const tree = createTreeWithEmptyWorkspace();
    writeJson(tree, 'nx.json', { plugins: ['other-plugin'] });
    expect(prepareNextInference(tree, 'apps/site')).toBe(true);
    expect(readJson(tree, 'nx.json').plugins).toEqual([
      'other-plugin',
      {
        plugin: '@nx/next/plugin',
        options: {
          buildTargetName: 'build',
          devTargetName: 'dev',
          startTargetName: 'start',
          serveStaticTargetName: 'serve-static',
          buildDepsTargetName: 'build-deps',
          watchDepsTargetName: 'watch-deps',
        },
        include: ['apps/site/next.config.{js,cjs,mjs,ts}'],
      },
    ]);
  });
  it('preserves an existing global target policy and rejects ambiguous policies', () => {
    const tree = createTreeWithEmptyWorkspace();
    const registration = {
      plugin: '@nx/next/plugin',
      options: { devTargetName: 'develop' },
    };
    writeJson(tree, 'nx.json', { plugins: [registration] });
    prepareNextInference(tree, 'apps/site');
    expect(readJson(tree, 'nx.json').plugins).toEqual([registration]);
    writeJson(tree, 'nx.json', {
      plugins: [
        registration,
        {
          plugin: '@nx/next/plugin',
          options: { devTargetName: 'dev' },
          include: ['apps/other/**'],
        },
      ],
    });
    expect(() => prepareNextInference(tree, 'apps/site')).toThrow(
      'different target policies',
    );
  });
  it('does not silently enable explicitly disabled inference', () => {
    const tree = createTreeWithEmptyWorkspace();
    writeJson(tree, 'nx.json', { useInferencePlugins: false });
    expect(() => prepareNextInference(tree, 'apps/site')).toThrow(
      'useInferencePlugins:false',
    );
    expect(readJson(tree, 'nx.json')).toEqual({ useInferencePlugins: false });
  });
  it.each([undefined, '48123', '0'])(
    'uses injected PORT=%s with a stable project cwd',
    (port) => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
      const spawn = vi.fn(() => child);
      const proc = Object.assign(new EventEmitter(), {
        env: port === undefined ? {} : { PORT: port },
        argv: ['node', 'server.cjs', 'dev', '--hostname', '127.0.0.1'],
        execPath: '/node',
        exitCode: undefined as number | undefined,
      });
      const req = Object.assign(
        (name: string) =>
          name === 'node:child_process'
            ? { spawn }
            : { resolve: (...parts: string[]) => parts.join('/') },
        { resolve: () => '/workspace/node_modules/next/dist/bin/next' },
      );
      runInNewContext(nextServerSource(45000), {
        require: req,
        process: proc,
        __dirname: '/workspace/apps/site/scripts',
        console,
      });
      expect(spawn).toHaveBeenCalledWith(
        '/node',
        [
          '/workspace/node_modules/next/dist/bin/next',
          'dev',
          '--port',
          port ?? '45000',
          '--hostname',
          '127.0.0.1',
        ],
        expect.objectContaining({
          cwd: '/workspace/apps/site/scripts/..',
          env: expect.objectContaining({ NX_DAEMON: 'false' }),
        }),
      );
      proc.emit('SIGTERM');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.emit('exit', 7, null);
      expect(proc.exitCode).toBe(7);
    },
  );
  it.each(['', '-1', '65536', '123x', ' 4000'])(
    'rejects invalid PORT=%s before spawning',
    (port) => {
      const spawn = vi.fn();
      const req = (name: string) =>
        name === 'node:child_process' ? { spawn } : {};
      expect(() =>
        runInNewContext(nextServerSource(45000), {
          require: req,
          process: { env: { PORT: port }, argv: ['node', 'script', 'dev'] },
        }),
      ).toThrow('PORT must be an integer');
      expect(spawn).not.toHaveBeenCalled();
    },
  );
});
