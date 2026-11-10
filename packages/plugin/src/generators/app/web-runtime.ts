import {
  getProjects,
  readJson,
  updateJson,
  updateProjectConfiguration,
  type Tree,
} from '@nx/devkit';
import { nxWorkspaceCapabilities } from '../../lib/workspace-compatibility';

interface NextRegistration {
  plugin: '@nx/next/plugin';
  options?: Record<string, string>;
  include?: string[];
  exclude?: string[];
}

/** Add inference for this new application without enrolling existing apps. */
export function prepareNextInference(tree: Tree, directory: string): boolean {
  const major = nxWorkspaceCapabilities(tree).major;
  if (major < 18) return false;
  const nx = readJson<{
    useInferencePlugins?: boolean;
    plugins?: (string | NextRegistration)[];
  }>(tree, 'nx.json');
  if (
    nx.useInferencePlugins === false ||
    process.env.NX_ADD_PLUGINS === 'false'
  )
    throw new Error(
      'Adding a Next.js application requires inference on Nx 18+. Review useInferencePlugins:false before generation; existing applications were not migrated.',
    );
  const registrations = (nx.plugins ?? []).filter(
    (entry) =>
      (typeof entry === 'string' ? entry : entry.plugin) === '@nx/next/plugin',
  );
  const canonical = (entry: string | NextRegistration) => ({
    buildTargetName: 'build',
    devTargetName: 'dev',
    startTargetName: 'start',
    serveStaticTargetName: 'serve-static',
    buildDepsTargetName: 'build-deps',
    watchDepsTargetName: 'watch-deps',
    ...(typeof entry === 'object' ? entry.options : {}),
  });
  if (
    new Set(
      registrations.map((entry) =>
        JSON.stringify(Object.entries(canonical(entry)).sort()),
      ),
    ).size > 1
  )
    throw new Error(
      'Existing Next.js inference registrations use different target policies. Review scoped registrations before adding this application.',
    );
  const policy = canonical(registrations[0] ?? '@nx/next/plugin');
  const targets = [
    policy.buildTargetName,
    policy.devTargetName,
    policy.startTargetName,
  ];
  if (
    targets.some((name) => typeof name !== 'string' || !name.trim()) ||
    new Set(targets).size !== targets.length
  )
    throw new Error(
      'Next.js build, development and start targets must have distinct nonempty names.',
    );
  if (
    !registrations.some(
      (entry) =>
        typeof entry === 'string' || (!entry.include && !entry.exclude),
    )
  )
    updateJson(tree, 'nx.json', (value) => ({
      ...value,
      plugins: [
        ...(value.plugins ?? []),
        {
          plugin: '@nx/next/plugin',
          options: canonical(registrations[0] ?? '@nx/next/plugin'),
          include: [`${directory}/next.config.{js,cjs,mjs,ts}`],
        },
      ],
    }));
  return true;
}

export function nextServerSource(
  defaultPort: number,
  portKey?: string,
): string {
  const configured = portKey
    ? `
// megamono.json ports.${portKey} wins over the port recorded at generation.
function configuredPort() {
  const { existsSync, readFileSync } = require('node:fs');
  for (let directory = resolve(__dirname, '..'); ; ) {
    const file = resolve(directory, 'megamono.json');
    if (existsSync(file)) {
      const value = JSON.parse(readFileSync(file, 'utf8')).ports?.[${JSON.stringify(portKey)}];
      return Number.isInteger(value) ? String(value) : undefined;
    }
    const parent = resolve(directory, '..');
    if (parent === directory) return undefined;
    directory = parent;
  }
}`
    : '';
  return `// Run directly or through Nx; resolution never depends on the invoking directory.
const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const mode = process.argv[2];
if (!['dev', 'start'].includes(mode)) throw new Error('Expected dev or start.');${configured}
const port = process.env.PORT ?? ${portKey ? 'configuredPort() ?? ' : ''}'${defaultPort}';
if (!/^\\d+$/.test(port) || Number(port) > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), mode, '--port', port, ...process.argv.slice(3)], {
  cwd: resolve(__dirname, '..'), stdio: 'inherit', env: { ...process.env, NX_DAEMON: 'false' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
`;
}

/** Keep build inference; give serving a tested PORT/default-port contract. */
export function configureNextRuntime(
  tree: Tree,
  projectName: string,
  directory: string,
  port: number,
  skipDependencyDeclarations = false,
  portKey?: string,
): void {
  const project = getProjects(tree).get(projectName);
  if (!project) throw new Error(`Next.js did not generate ${projectName}.`);
  const nx = readJson<{ plugins?: (string | NextRegistration)[] }>(
    tree,
    'nx.json',
  );
  const registration = nx.plugins?.find(
    (entry) =>
      (typeof entry === 'string' ? entry : entry.plugin) === '@nx/next/plugin',
  );
  const policy =
    typeof registration === 'object' ? registration.options : undefined;
  const dev = policy?.devTargetName ?? 'dev';
  const start = policy?.startTargetName ?? 'start';
  const serve = (mode: string) => ({
    executor: 'nx:run-commands',
    cache: false,
    ...(nxWorkspaceCapabilities(tree).continuousTargets
      ? { continuous: true }
      : {}),
    options: {
      command: `node scripts/next-server.cjs ${mode}`,
      cwd: directory,
    },
  });
  updateProjectConfiguration(tree, projectName, {
    ...project,
    targets: {
      ...project.targets,
      [dev]: { ...project.targets?.[dev], ...serve('dev') },
      [start]: {
        ...project.targets?.[start],
        ...serve('start'),
        dependsOn: [policy?.buildTargetName ?? 'build'],
      },
      // Retain the familiar serve command used by process supervisors.
      ...(dev !== 'serve' &&
      start !== 'serve' &&
      policy?.serveStaticTargetName !== 'serve'
        ? { serve: serve('dev') }
        : {}),
    },
  });
  tree.write(
    `${directory}/scripts/next-server.cjs`,
    nextServerSource(port, portKey),
  );
  tree.write(
    `${directory}/next.config.js`,
    `//@ts-check\n\n/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nmodule.exports = nextConfig;\n`,
  );
  // Next owns image declarations; Nx's legacy SVG ambient module collides
  // with next/image-types/global.d.ts when using the plain Next configuration.
  tree.delete(`${directory}/index.d.ts`);
  if (tree.exists(`${directory}/tsconfig.json`))
    updateJson(tree, `${directory}/tsconfig.json`, (value) => ({
      ...value,
      compilerOptions: {
        ...value.compilerOptions,
        ...(skipDependencyDeclarations ? { skipLibCheck: true } : {}),
      },
      include: value.include?.filter((entry: string) => entry !== 'index.d.ts'),
    }));
}
