import {
  formatFiles,
  getProjects,
  logger,
  readJson,
  runTasksInSerial,
  updateJson,
  workspaceRoot,
  writeJson,
  type GeneratorCallback,
  type ProjectConfiguration,
  type Tree,
} from '@nx/devkit';
import { prompt } from 'enquirer';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';
import { isSafeWorkspaceRelativePath } from '../../lib/config';
import {
  assertWorkspaceMutationGitPreflight,
  collectWorkspaceInitHostState,
} from '../../lib/workspace-init-preflight';
import type { AppGeneratorSchema, AppType } from './schema';
import {
  isPackageManager,
  lockfileManagers,
  packageManagerAdapter,
  packageManagerExec,
  type PackageManager,
} from '../../lib/package-manager';
import {
  WEB_STYLING_OPTIONS,
  detectWebStyling,
  isWebStyling,
  type ResolvedWebStyling,
  type WebStyling,
} from '../../lib/web-styling';
import {
  billboardCss,
  billboardSource as styledBillboardSource,
} from './web-billboard';

export const APP_TYPES = [
  'web',
  'site',
  'api',
  'worker',
  'mobile',
  'desktop',
  'apple',
  'extension',
] as const satisfies readonly AppType[];

const APP_TYPE_SET = new Set<string>(APP_TYPES);
const APP_LABELS: Record<AppType, string> = {
  web: 'Web app',
  site: 'Marketing site',
  api: 'Nest API',
  worker: 'Cloudflare Worker',
  mobile: 'Expo mobile app',
  desktop: 'Tauri desktop app',
  apple: 'Apple native app',
  extension: 'WXT browser extension',
};
const compatibility = JSON.parse(
  readFileSync(join(__dirname, '../../../compatibility.json'), 'utf8'),
) as {
  readonly scaffoldPackages: Record<string, string>;
  readonly rustCrates: Record<string, string>;
};

function packageVersion(name: string): string {
  const version = compatibility.scaffoldPackages[name];
  if (!version) {
    throw new AppGeneratorError(
      `No compatible scaffold package version is registered for ${name}.`,
      3,
      'compatibility',
    );
  }
  return version;
}

function rustCrateVersion(name: string): string {
  const version = compatibility.rustCrates[name];
  if (!version) {
    throw new AppGeneratorError(
      `No compatible Rust crate version is registered for ${name}.`,
      3,
      'compatibility',
    );
  }
  return version;
}

interface NormalizedAppOptions {
  readonly type: AppType;
  readonly name: string;
  readonly directory: string;
  readonly scope: string;
  readonly projectName: string;
  readonly packageName: string;
  readonly platform:
    'web' | 'node' | 'worker' | 'mobile' | 'apple' | 'rust' | 'extension';
  readonly tags: readonly string[];
  readonly port?: number;
  readonly styling?: ResolvedWebStyling;
  readonly packageManager: PackageManager;
  readonly workspaceName: string;
  readonly requestedApps: readonly AppType[];
  readonly requestedServices: readonly string[];
  readonly serviceRunner: 'none' | 'springbar';
  readonly dryRun: boolean;
  readonly bootstrap: boolean;
}

export class AppGeneratorError extends Error {
  readonly diagnosticCode: string;

  constructor(
    message: string,
    readonly exitCode: 2 | 3 | 4,
    diagnostic: string,
  ) {
    super(message);
    this.name = 'AppGeneratorError';
    this.diagnosticCode = `app-${diagnostic}`;
  }
}

function canPrompt(options: AppGeneratorSchema): boolean {
  return (
    options.interactive !== false &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true
  );
}

async function resolveType(options: AppGeneratorSchema): Promise<AppType> {
  if (options.type) {
    if (!APP_TYPE_SET.has(options.type)) {
      throw new AppGeneratorError(
        `Unknown application type ${options.type}. Expected one of: ${APP_TYPES.join(', ')}.`,
        2,
        'options',
      );
    }
    return options.type;
  }
  if (!canPrompt(options)) {
    throw new AppGeneratorError(
      `Application type is required in non-interactive mode. Expected one of: ${APP_TYPES.join(', ')}.`,
      4,
      'decision-required',
    );
  }
  const answer = await prompt<{ type: AppType }>({
    type: 'select',
    name: 'type',
    message: 'Which application preset should be added?',
    choices: APP_TYPES.map((type) => ({
      name: type,
      message: APP_LABELS[type],
    })),
  });
  return answer.type;
}

function slug(value: string, label: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) {
    throw new AppGeneratorError(
      `${label} must contain a letter or number.`,
      2,
      'options',
    );
  }
  return normalized;
}

function packageManager(tree: Tree): PackageManager {
  const managers = lockfileManagers((path) => tree.exists(path));
  const declared = readJson<{ packageManager?: string }>(
    tree,
    'package.json',
  ).packageManager?.split('@')[0];
  if (managers.length > 1) {
    throw new AppGeneratorError(
      `Conflicting root package-manager lockfiles are not supported: ${managers.join(', ')}.`,
      3,
      'package-manager',
    );
  }
  const locked = managers[0];
  if (declared && !isPackageManager(declared)) {
    throw new AppGeneratorError(
      `Unsupported package manager ${declared}.`,
      3,
      'package-manager',
    );
  }
  if (declared && locked && declared !== locked) {
    throw new AppGeneratorError(
      `package.json declares ${declared}, but the root lockfile belongs to ${locked}.`,
      3,
      'package-manager',
    );
  }
  const selected = locked ?? (declared as PackageManager | undefined);
  if (!selected) {
    throw new AppGeneratorError(
      'Declare packageManager or commit a supported root lockfile before adding an application.',
      3,
      'package-manager',
    );
  }
  return selected;
}

function workspaceIdentity(tree: Tree): {
  readonly name: string;
  readonly scope: string;
} {
  const manifest = readJson<{ name?: string }>(tree, 'package.json');
  const raw =
    manifest.name?.replace(/^@/, '').replace(/\//g, '-') ?? 'workspace';
  const name = raw || 'workspace';
  return { name, scope: slug(name, 'Workspace package name') };
}

function platform(type: AppType): NormalizedAppOptions['platform'] {
  if (type === 'api') return 'node';
  if (type === 'worker') return 'worker';
  if (type === 'mobile') return 'mobile';
  if (type === 'apple') return 'apple';
  if (type === 'desktop') return 'rust';
  if (type === 'extension') return 'extension';
  return 'web';
}

function automaticPort(
  type: AppType,
  name: string,
  scope: string,
  configured: Readonly<Record<string, number>>,
): number | undefined {
  if (configured[name]) return configured[name];
  if (type !== 'api' && type !== 'site' && type !== 'web' && type !== 'worker')
    return undefined;
  const hash = [...scope].reduce(
    (value, character) => (value * 31 + (character.codePointAt(0) ?? 0)) >>> 0,
    0,
  );
  const workspaceBase = 40_000 + (hash % 8_000);
  const preferred =
    type === 'worker'
      ? 8787
      : workspaceBase + { api: 0, site: 1, web: 2 }[type];
  if (name === type) return preferred;
  const assigned = new Set(Object.values(configured));
  let candidate = preferred + 10;
  while (assigned.has(candidate)) candidate += 1;
  return candidate;
}

function csv<T extends string>(
  value: string | undefined,
  allowed?: ReadonlySet<string>,
): T[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].filter((entry) => !allowed || allowed.has(entry)) as T[];
}

async function normalizeOptions(
  tree: Tree,
  raw: AppGeneratorSchema,
): Promise<NormalizedAppOptions> {
  const type = await resolveType(raw);
  if (!raw.bootstrap && !tree.exists('megamono.json')) {
    throw new AppGeneratorError(
      'This workspace is not initialized. Run megamono init before adding applications.',
      3,
      'not-initialized',
    );
  }
  const identity = workspaceIdentity(tree);
  const name = slug(raw.name ?? type, 'Application name');
  const scope = slug(raw.scope ?? identity.scope, 'Application scope');
  const directory =
    raw.directory?.replace(/^\.\//, '').replace(/\/$/, '') ?? `apps/${name}`;
  if (!isSafeWorkspaceRelativePath(directory) || directory === 'apps') {
    throw new AppGeneratorError(
      `Application directory must be a safe workspace-relative child path; received ${directory}.`,
      2,
      'options',
    );
  }
  if (
    raw.port !== undefined &&
    (!Number.isInteger(raw.port) || raw.port < 1024 || raw.port > 65535)
  ) {
    throw new AppGeneratorError(
      'Application port must be an integer from 1024 through 65535.',
      2,
      'options',
    );
  }
  const selectedPlatform = platform(type);
  const configuredPorts = !raw.bootstrap
    ? (readJson<{ ports?: Record<string, number> }>(tree, 'megamono.json')
        .ports ?? {})
    : {};
  const selectedPort =
    raw.port ?? automaticPort(type, name, scope, configuredPorts);
  if (
    selectedPort !== undefined &&
    Object.entries(configuredPorts).some(
      ([configuredName, port]) =>
        configuredName !== name && port === selectedPort,
    )
  ) {
    throw new AppGeneratorError(
      `Application port ${selectedPort} is already assigned in megamono.json.`,
      3,
      'port-conflict',
    );
  }
  const styling =
    type === 'web' || type === 'site'
      ? await resolveWebStyling(tree, raw)
      : undefined;
  return {
    type,
    name,
    directory,
    scope,
    projectName: `${scope}-${name}`,
    packageName: `@${scope}/${name}`,
    platform: selectedPlatform,
    tags: [
      `platform:${selectedPlatform}`,
      `scope:${scope}`,
      'type:app',
      'visibility:internal',
    ],
    port: selectedPort,
    ...(styling ? { styling } : {}),
    packageManager: packageManager(tree),
    workspaceName: raw.workspaceName?.trim() || identity.name,
    requestedApps: csv<AppType>(raw.requestedApps, APP_TYPE_SET),
    requestedServices: csv(raw.requestedServices),
    serviceRunner: raw.serviceRunner ?? 'none',
    dryRun: raw.dryRun === true || process.env.NX_DRY_RUN === 'true',
    bootstrap: raw.bootstrap === true,
  };
}

const STYLING_LABELS: Record<ResolvedWebStyling, string> = {
  chakra: 'Chakra UI (suggested)',
  emotion: 'Emotion',
  tailwind: 'Tailwind CSS',
  panda: 'Panda CSS',
  stylex: 'StyleX',
  'css-modules': 'CSS Modules',
  inline: 'Inline styles (dependency-free fallback)',
};

async function resolveWebStyling(
  tree: Tree,
  options: AppGeneratorSchema,
): Promise<ResolvedWebStyling> {
  if (options.styling && !isWebStyling(options.styling)) {
    throw new AppGeneratorError(
      `Unknown styling option ${options.styling}. Expected one of: ${WEB_STYLING_OPTIONS.join(', ')}.`,
      2,
      'options',
    );
  }
  let selected: WebStyling = options.styling ?? 'auto';
  if (selected === 'auto' && tree.exists('megamono.json')) {
    const config = readJson<{
      scaffolding?: { web?: { styling?: string } };
      conventions?: { apps?: { web?: { ui?: string } } };
    }>(tree, 'megamono.json');
    const configured = config.scaffolding?.web?.styling;
    if (configured && isWebStyling(configured)) selected = configured;
    else if (config.conventions?.apps?.web?.ui === 'chakra')
      selected = 'chakra';
  }
  if (selected === 'auto') selected = detectWebStyling(tree);
  if (selected !== 'auto') return selected;
  if (!canPrompt(options)) return 'css-modules';
  const answer = await prompt<{ styling: ResolvedWebStyling }>({
    type: 'select',
    name: 'styling',
    message: 'How should the generated billboard be styled?',
    initial: 0,
    choices: Object.entries(STYLING_LABELS).map(([name, message]) => ({
      name,
      message,
    })),
  });
  return answer.styling;
}

function projectMatches(
  project: ProjectConfiguration,
  options: NormalizedAppOptions,
): boolean {
  const tags = new Set(project.tags ?? []);
  return (
    project.root === options.directory &&
    project.projectType === 'application' &&
    options.tags.every((tag) => tags.has(tag))
  );
}

function assertProjectPreflight(
  tree: Tree,
  options: NormalizedAppOptions,
): 'create' | 'noop' {
  const projects = getProjects(tree);
  const named = projects.get(options.projectName);
  const rooted = [...projects.entries()].find(
    ([, project]) => project.root === options.directory,
  );
  if (named && projectMatches(named, options)) return 'noop';
  if (named || rooted || tree.exists(options.directory)) {
    const occupied = named
      ? `project ${options.projectName}`
      : rooted
        ? `project ${rooted[0]}`
        : `path ${options.directory}`;
    throw new AppGeneratorError(
      `Cannot add ${options.type}: ${occupied} is already occupied by a different contract.`,
      3,
      'conflict',
    );
  }
  return 'create';
}

function renderPlan(options: NormalizedAppOptions): string {
  const lines = [
    '# Megamono application plan',
    '',
    `- Type: ${options.type}`,
    `- Project: ${options.projectName}`,
    `- Root: ${options.directory}`,
    `- Package: ${options.packageName}`,
    `- Tags: ${options.tags.join(', ')}`,
    ...(options.port ? [`- Port: ${options.port}`] : []),
    ...(options.styling ? [`- Styling: ${options.styling}`] : []),
    '',
    '## Ordered operations',
    '',
    `1. Compose the maintained ${options.type} framework generator.`,
    '2. Apply Megamono package, tag, lint, test, and source conventions.',
    '3. Format the generated tree and run deferred dependency installation.',
  ];
  return `${lines.join('\n')}\n`;
}

type ComposedGenerator = (
  tree: Tree,
  options: Record<string, unknown>,
) => Promise<GeneratorCallback | void>;

function localRequire(packageName: string): Record<string, unknown> {
  try {
    return createRequire(posix.join(workspaceRoot, 'package.json'))(
      packageName,
    ) as Record<string, unknown>;
  } catch {
    throw new AppGeneratorError(
      `Required application plugin ${packageName} is not installed locally.`,
      3,
      'plugin-missing',
    );
  }
}

function generator(packageName: string, exportName: string): ComposedGenerator {
  const value = localRequire(packageName)[exportName];
  if (typeof value !== 'function') {
    throw new AppGeneratorError(
      `${packageName} does not expose the compatible ${exportName} generator.`,
      3,
      'plugin-incompatible',
    );
  }
  return value as ComposedGenerator;
}

function updatePackage(
  tree: Tree,
  path: string,
  options: NormalizedAppOptions,
  dependencies: Record<string, string> = {},
): void {
  const e2e = path.includes('-e2e/');
  const update = (value: Record<string, unknown>) => ({
    ...value,
    name: e2e ? `${options.packageName}-e2e` : options.packageName,
    ...(Object.keys(dependencies).length
      ? {
          dependencies: {
            ...((value.dependencies as Record<string, string> | undefined) ??
              {}),
            ...dependencies,
          },
        }
      : {}),
    nx: {
      ...((value.nx as Record<string, unknown> | undefined) ?? {}),
      ...(e2e ? { name: `${options.projectName}-e2e` } : {}),
      projectType: 'application',
      tags: options.tags,
    },
  });
  if (tree.exists(path)) updateJson(tree, path, update);
  else writeJson(tree, path, update({ private: true }));
}

function workspaceDependency(options: NormalizedAppOptions): string {
  return packageManagerAdapter(options.packageManager).workspaceDependency('*');
}

function themeSystemSource(): string {
  return `import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';

const config = defineConfig({
  globalCss: {
    html: { bg: '{colors.gray.950}', colorPalette: 'yellow' },
    body: { bg: '{colors.gray.950}', color: '{colors.gray.50}' },
    '::selection': { bg: '{colors.yellow.300}', color: '{colors.gray.950}' },
  },
  theme: {
    semanticTokens: {
      colors: {
        accent: { value: '{colors.yellow.300}' },
        panel: { value: '{colors.gray.900}' },
      },
    },
  },
});

export const megamonoSystem = createSystem(defaultConfig, config);
`;
}

function chakraBillboardSource(options: NormalizedAppOptions): string {
  const nx = packageManagerAdapter(options.packageManager).nx;
  const surfaces = (
    options.requestedApps.length ? options.requestedApps : [options.type]
  ).map((type) => APP_LABELS[type]);
  const services = options.requestedServices.map((service) =>
    service === 'postgres' ? 'PostgreSQL' : service,
  );
  return `import { Badge, Box, Code, Container, Heading, Link, SimpleGrid, Stack, Text } from '@chakra-ui/react';
import Head from 'next/head';

const commands = ${JSON.stringify([`${nx} show projects`, `${nx} graph`, `${nx} run megamono:check`])};
const surfaces: string[] = ${JSON.stringify(surfaces)};
const services: string[] = ${JSON.stringify(services)};
const tools = [
  ['Megamono', 'https://megamono.com', 'Explore Megamono'],
  ['Playstack', 'https://playstack.dev', 'Explore Playstack'],
  ['Springbar', 'https://springbar.app', 'Explore Springbar'],
  ['Commune Software', 'https://www.commune.software', 'Visit Commune Software'],
] as const;

export default function Index() {
  return (
    <>
      <Head><title>${options.workspaceName} · Built with Megamono</title></Head>
      <Box as="main" minH="100vh" bg="gray.950" color="gray.50">
        <Container maxW="7xl" py={{ base: '12', md: '20' }}>
          <Stack gap="12">
            <Badge alignSelf="flex-start" colorPalette="yellow">Commune development tools</Badge>
            <Heading as="h1" fontSize={{ base: '4xl', md: '7xl' }}>${options.workspaceName} is ready to build.</Heading>
            <Text color="gray.300" fontSize="xl">Megamono prepared this workspace so people and agents can build against the same architecture.</Text>
            <Heading as="h2">Generated surfaces</Heading>
            <SimpleGrid columns={{ base: 1, md: 2 }} gap="4">
              {surfaces.map((surface) => <Badge key={surface}>{surface}</Badge>)}
            </SimpleGrid>
            <Heading as="h2">Requested services</Heading>
            <SimpleGrid columns={{ base: 1, md: 2 }} gap="4">
              {(services.length ? services : ['None requested']).map((service) => <Badge key={service}>{service}</Badge>)}
            </SimpleGrid>
            <Heading as="h2">How to use Megamono</Heading>
            <Text>Keep applications thin composition roots, place reusable behavior in tagged libraries, and capture durable intent in docs.</Text>
            <Stack>{commands.map((command) => <Code key={command}>{command}</Code>)}</Stack>
            <Heading as="h2">Keep building with Commune</Heading>
            <SimpleGrid columns={{ base: 1, md: 2 }} gap="6">
              {tools.map(([name, href, label]) => (
                <Stack key={name}><Heading as="h3" size="lg">{name}</Heading><Link href={href} target="_blank" rel="noreferrer">{label}</Link></Stack>
              ))}
            </SimpleGrid>
          </Stack>
        </Container>
      </Box>
    </>
  );
}
`;
}

function billboardE2eSource(options: NormalizedAppOptions): string {
  return `import { expect, test } from '@playwright/test';

test('introduces the workspace and Commune development tools', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '${options.workspaceName} is ready to build.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How to use Megamono' })).toBeVisible();
  await expect(page.getByText('${APP_LABELS[options.type]}', { exact: true })).toBeVisible();
  for (const [name, href] of [
    ['Explore Megamono', 'https://megamono.com'],
    ['Explore Playstack', 'https://playstack.dev'],
    ['Explore Springbar', 'https://springbar.app'],
    ['Visit Commune Software', 'https://www.commune.software'],
  ] as const) await expect(page.getByRole('link', { name })).toHaveAttribute('href', href);
});
`;
}

function configureE2ePackage(tree: Tree, options: NormalizedAppOptions): void {
  const e2eRoot = `${options.directory}-e2e`;
  const packagePath = `${e2eRoot}/package.json`;
  const projectExists = [...getProjects(tree).values()].some(
    (project) => project.root === e2eRoot,
  );
  if (!projectExists && tree.children(e2eRoot).length === 0) return;
  updatePackage(tree, packagePath, options);

  if (options.type === 'api') {
    updateJson(tree, packagePath, (value: Record<string, unknown>) => {
      const nx = (value.nx as Record<string, unknown> | undefined) ?? {};
      const targets = (nx.targets as Record<string, unknown> | undefined) ?? {};
      const e2e = (targets.e2e as Record<string, unknown> | undefined) ?? {};
      return {
        ...value,
        nx: {
          ...nx,
          targets: {
            ...targets,
            e2e: {
              ...e2e,
              options: {
                ...((e2e.options as Record<string, unknown> | undefined) ?? {}),
                jestConfig: `${e2eRoot}/jest.config.cjs`,
              },
            },
          },
        },
      };
    });
    tree.write(
      'jest.preset.js',
      "const nxPreset = require('@nx/jest/preset').default;\n\nmodule.exports = { ...nxPreset };\n",
    );
    const presetRoot = posix.relative(e2eRoot, '.') || '.';
    tree.write(
      `${e2eRoot}/jest.config.cjs`,
      `const { readFileSync } = require('node:fs');

const swcJestConfig = JSON.parse(
  readFileSync(\`${'${__dirname}'}/.spec.swcrc\`, 'utf8'),
);
swcJestConfig.swcrc = false;

module.exports = {
  displayName: '${options.projectName}-e2e',
  preset: '${presetRoot}/jest.preset.js',
  globalSetup: '<rootDir>/src/support/global-setup.ts',
  globalTeardown: '<rootDir>/src/support/global-teardown.ts',
  setupFiles: ['<rootDir>/src/support/test-setup.ts'],
  testEnvironment: 'node',
  transform: { '^.+\\\\.[tj]s$': ['@swc/jest', swcJestConfig] },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: 'test-output/jest/coverage',
};
`,
    );
    tree.delete(`${e2eRoot}/jest.config.cts`);
    if (tree.exists(`${e2eRoot}/tsconfig.json`)) {
      updateJson(
        tree,
        `${e2eRoot}/tsconfig.json`,
        (value: Record<string, unknown>) => ({
          ...value,
          include: ((value.include as string[] | undefined) ?? []).filter(
            (entry) => !entry.startsWith('jest.config.'),
          ),
        }),
      );
    }
    if (options.port) {
      const replacements = [
        [
          `${e2eRoot}/src/support/test-setup.ts`,
          "process.env.PORT ?? '3000'",
          `process.env.PORT ?? '${options.port}'`,
        ],
        [
          `${e2eRoot}/src/support/global-setup.ts`,
          ': 3000',
          `: ${options.port}`,
        ],
        [
          `${e2eRoot}/src/support/global-teardown.ts`,
          ': 3000',
          `: ${options.port}`,
        ],
      ] as const;
      for (const [path, current, replacement] of replacements) {
        if (tree.exists(path)) {
          tree.write(
            path,
            (tree.read(path, 'utf8') ?? '').replace(current, replacement),
          );
        }
      }
    }
    return;
  }

  const nx = packageManagerAdapter(options.packageManager).nx;
  const port = options.port ?? 4200;
  tree.write(
    `${e2eRoot}/playwright.config.mts`,
    `import { defineConfig, devices } from '@playwright/test';
import { workspaceRoot } from '@nx/devkit';
import { nxE2EPreset } from '@nx/playwright/preset';

const port = process.env['PORT'] || '${port}';
const baseURL = process.env['BASE_URL'] || \`http://localhost:\${port}\`;

export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './src' }),
  use: { baseURL, trace: 'on-first-retry' },
  webServer: {
    command: \`${nx} run ${options.projectName}:dev --port=\${port}\`,
    url: baseURL,
    reuseExistingServer: false,
    cwd: workspaceRoot,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
`,
  );
}

async function ensureTheme(
  tree: Tree,
  options: NormalizedAppOptions,
): Promise<GeneratorCallback | void> {
  const themeRoot = 'packages/theme';
  const themeProject = `${options.scope}-theme`;
  const existing = getProjects(tree).get(themeProject);
  if (existing) return;
  if (tree.exists(themeRoot)) {
    throw new AppGeneratorError(
      `Cannot add ${options.type}: path ${themeRoot} is occupied.`,
      3,
      'conflict',
    );
  }
  const callback = await generator('@nx/js', 'libraryGenerator')(tree, {
    name: themeProject,
    directory: themeRoot,
    importPath: `@${options.scope}/theme`,
    bundler: 'none',
    linter: 'eslint',
    unitTestRunner: 'none',
    strict: true,
    minimal: true,
    tags: `platform:web,scope:${options.scope},type:ui`,
    skipFormat: true,
  });
  const updateTheme = (value: Record<string, unknown>) => ({
    ...value,
    name: `@${options.scope}/theme`,
    private: true,
    dependencies: {
      ...((value.dependencies as Record<string, string> | undefined) ?? {}),
      '@chakra-ui/react': packageVersion('@chakra-ui/react'),
      '@emotion/react': packageVersion('@emotion/react'),
    },
  });
  if (tree.exists(`${themeRoot}/package.json`))
    updateJson(tree, `${themeRoot}/package.json`, updateTheme);
  else writeJson(tree, `${themeRoot}/package.json`, updateTheme({}));
  tree.write(
    `${themeRoot}/src/index.ts`,
    "export { megamonoSystem } from './lib/system';\n",
  );
  tree.write(`${themeRoot}/src/lib/system.ts`, themeSystemSource());
  return callback;
}

async function createWebApp(
  tree: Tree,
  options: NormalizedAppOptions,
): Promise<readonly (GeneratorCallback | void)[]> {
  const styling = options.styling ?? 'css-modules';
  const callbacks: (GeneratorCallback | void)[] = [];
  if (styling === 'chakra') callbacks.push(await ensureTheme(tree, options));
  callbacks.push(
    await generator('@nx/next', 'applicationGenerator')(tree, {
      name: options.projectName,
      directory: options.directory,
      appDir: false,
      src: true,
      style: 'css',
      linter: 'eslint',
      unitTestRunner: 'none',
      e2eTestRunner: 'playwright',
      tags: options.tags.join(','),
      skipFormat: true,
    }),
  );
  const dependencies: Record<string, string> =
    styling === 'chakra'
      ? {
          '@chakra-ui/react': packageVersion('@chakra-ui/react'),
          [`@${options.scope}/theme`]: workspaceDependency(options),
        }
      : styling === 'emotion'
        ? { '@emotion/react': packageVersion('@emotion/react') }
        : styling === 'stylex'
          ? {
              '@stylexjs/stylex': packageVersion('@stylexjs/stylex'),
              '@stylexjs/babel-plugin': packageVersion(
                '@stylexjs/babel-plugin',
              ),
              '@stylexjs/postcss-plugin': packageVersion(
                '@stylexjs/postcss-plugin',
              ),
            }
          : styling === 'tailwind'
            ? {
                tailwindcss: packageVersion('tailwindcss'),
                '@tailwindcss/postcss': packageVersion('@tailwindcss/postcss'),
              }
            : styling === 'panda'
              ? { '@pandacss/dev': packageVersion('@pandacss/dev') }
              : {};
  updatePackage(
    tree,
    `${options.directory}/package.json`,
    options,
    dependencies,
  );
  const e2eRoot = `${options.directory}-e2e`;
  if (tree.exists(`${e2eRoot}/package.json`))
    updatePackage(tree, `${e2eRoot}/package.json`, options);
  tree.delete(`${options.directory}/src/pages/index.module.css`);
  if (styling === 'chakra') {
    tree.delete(`${options.directory}/src/pages/styles.css`);
    tree.write(
      `${options.directory}/src/pages/_app.tsx`,
      `import { ChakraProvider } from '@chakra-ui/react';\nimport { megamonoSystem } from '@${options.scope}/theme';\nimport type { AppProps } from 'next/app';\n\nexport default function App({ Component, pageProps }: AppProps) {\n  return <ChakraProvider value={megamonoSystem}><Component {...pageProps} /></ChakraProvider>;\n}\n`,
    );
  } else {
    tree.write(
      `${options.directory}/src/pages/_app.tsx`,
      `import './styles.css';\nimport type { AppProps } from 'next/app';\n\nexport default function App({ Component, pageProps }: AppProps) {\n  return <Component {...pageProps} />;\n}\n`,
    );
    tree.write(
      `${options.directory}/src/pages/styles.css`,
      styling === 'tailwind'
        ? '@import "tailwindcss";\n'
        : styling === 'panda'
          ? '@layer reset, base, tokens, recipes, utilities;\n'
          : 'html, body { margin: 0; }\n* { box-sizing: border-box; }\n',
    );
  }
  if (styling === 'css-modules') {
    tree.write(
      `${options.directory}/src/pages/index.module.css`,
      billboardCss(),
    );
  }
  if (styling === 'tailwind') {
    tree.write(
      `${options.directory}/postcss.config.cjs`,
      `module.exports = { plugins: { '@tailwindcss/postcss': {} } };\n`,
    );
  }
  if (styling === 'panda') {
    tree.write(
      `${options.directory}/panda.config.ts`,
      `import { defineConfig } from '@pandacss/dev';\n\nexport default defineConfig({\n  preflight: true,\n  include: ['./src/**/*.{ts,tsx}'],\n  exclude: [],\n  outdir: 'styled-system',\n});\n`,
    );
    tree.write(
      `${options.directory}/postcss.config.cjs`,
      `module.exports = { plugins: { '@pandacss/dev/postcss': {} } };\n`,
    );
    const invocation = packageManagerExec(options.packageManager, 'panda', [
      'codegen',
      '--config',
      'panda.config.ts',
    ]);
    callbacks.push(async () => {
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        execFile(
          invocation.command,
          [...invocation.args],
          { cwd: join(workspaceRoot, options.directory) },
          (error) => (error ? reject(error) : resolve()),
        );
      });
    });
  }
  if (styling === 'stylex') {
    tree.write(
      `${options.directory}/babel.config.js`,
      `module.exports = {\n  presets: ['next/babel'],\n  plugins: [['@stylexjs/babel-plugin', {\n    runtimeInjection: false,\n    dev: process.env.NODE_ENV !== 'production',\n    unstable_moduleResolution: { type: 'commonJS', rootDir: __dirname },\n  }]],\n};\n`,
    );
    tree.write(
      `${options.directory}/postcss.config.cjs`,
      `module.exports = { plugins: { '@stylexjs/postcss-plugin': { include: ['${options.directory}/src/**/*.{js,jsx,ts,tsx}'] } } };\n`,
    );
    tree.write(`${options.directory}/src/pages/styles.css`, '@stylex;\n');
  }
  tree.write(
    `${options.directory}/src/pages/index.tsx`,
    styling === 'chakra'
      ? chakraBillboardSource(options)
      : styledBillboardSource(
          {
            workspaceName: options.workspaceName,
            surfaces: (options.requestedApps.length
              ? options.requestedApps
              : [options.type]
            ).map((type) => APP_LABELS[type]),
            services: options.requestedServices.map((service) =>
              service === 'postgres' ? 'PostgreSQL' : service,
            ),
            commands: [
              `${packageManagerAdapter(options.packageManager).nx} show projects`,
              `${packageManagerAdapter(options.packageManager).nx} graph`,
              `${packageManagerAdapter(options.packageManager).nx} run megamono:check`,
            ],
          },
          styling,
        ),
  );
  tree.write(`${e2eRoot}/src/example.spec.ts`, billboardE2eSource(options));
  configureE2ePackage(tree, options);
  return callbacks;
}

async function createApiApp(
  tree: Tree,
  options: NormalizedAppOptions,
): Promise<readonly (GeneratorCallback | void)[]> {
  const nest = localRequire('@nx/nest');
  const appGenerator = nest.applicationGenerator;
  const libraryGenerator = nest.libraryGenerator;
  if (
    typeof appGenerator !== 'function' ||
    typeof libraryGenerator !== 'function'
  ) {
    throw new AppGeneratorError(
      '@nx/nest does not expose compatible application and library generators.',
      3,
      'plugin-incompatible',
    );
  }
  const callbacks: (GeneratorCallback | void)[] = [];
  callbacks.push(
    await (appGenerator as ComposedGenerator)(tree, {
      name: options.projectName,
      directory: options.directory,
      linter: 'eslint',
      unitTestRunner: 'none',
      e2eTestRunner: 'jest',
      tags: options.tags.join(','),
      skipFormat: true,
    }),
  );
  const featureName =
    options.name === 'api' ? 'nest-home' : `nest-${options.name}-home`;
  const featureRoot = `packages/${featureName}`;
  const featureProject = `${options.scope}-${featureName}`;
  callbacks.push(
    await (libraryGenerator as ComposedGenerator)(tree, {
      name: featureProject,
      directory: featureRoot,
      importPath: `@${options.scope}/${featureName}`,
      tags: `platform:node,scope:${options.scope},type:feature`,
      linter: 'eslint',
      unitTestRunner: 'jest',
      skipFormat: true,
    }),
  );
  updatePackage(tree, `${options.directory}/package.json`, options, {
    [`@${options.scope}/${featureName}`]: workspaceDependency(options),
  });
  const updateFeature = (value: Record<string, unknown>) => ({
    ...value,
    name: `@${options.scope}/${featureName}`,
    private: true,
    nx: {
      ...((value.nx as Record<string, unknown> | undefined) ?? {}),
      projectType: 'library',
      tags: ['platform:node', `scope:${options.scope}`, 'type:feature'],
    },
  });
  if (tree.exists(`${featureRoot}/package.json`))
    updateJson(tree, `${featureRoot}/package.json`, updateFeature);
  else writeJson(tree, `${featureRoot}/package.json`, updateFeature({}));
  const featureClass = featureName
    .split('-')
    .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join('');
  const sourceRoot = `${featureRoot}/src/lib`;
  tree.write(
    `${sourceRoot}/${featureName}.service.ts`,
    `import { Injectable } from '@nestjs/common';\n\n@Injectable()\nexport class ${featureClass}Service {\n  getData() { return { message: 'Hello API' }; }\n}\n`,
  );
  tree.write(
    `${sourceRoot}/${featureName}.controller.ts`,
    `import { Controller, Get } from '@nestjs/common';\nimport { ${featureClass}Service } from './${featureName}.service';\n\n@Controller()\nexport class ${featureClass}Controller {\n  constructor(private readonly service: ${featureClass}Service) {}\n  @Get() getData() { return this.service.getData(); }\n}\n`,
  );
  tree.write(
    `${sourceRoot}/${featureName}.module.ts`,
    `import { Module } from '@nestjs/common';\nimport { ${featureClass}Controller } from './${featureName}.controller';\nimport { ${featureClass}Service } from './${featureName}.service';\n\n@Module({ controllers: [${featureClass}Controller], providers: [${featureClass}Service] })\nexport class ${featureClass}Module {}\n`,
  );
  tree.write(
    `${featureRoot}/src/index.ts`,
    `export * from './lib/${featureName}.module';\nexport * from './lib/${featureName}.controller';\nexport * from './lib/${featureName}.service';\n`,
  );
  const appRoot = `${options.directory}/src/app`;
  tree.write(
    `${appRoot}/app.module.ts`,
    `import { ${featureClass}Module } from '@${options.scope}/${featureName}';\nimport { Module } from '@nestjs/common';\n\n@Module({ imports: [${featureClass}Module] })\nexport class AppModule {}\n`,
  );
  for (const path of [
    'app.controller.spec.ts',
    'app.controller.ts',
    'app.service.spec.ts',
    'app.service.ts',
  ])
    tree.delete(`${appRoot}/${path}`);
  const mainPath = `${options.directory}/src/main.ts`;
  if (options.port && tree.exists(mainPath)) {
    tree.write(
      mainPath,
      (tree.read(mainPath, 'utf8') ?? '').replace(
        'process.env.PORT || 3000',
        `process.env.PORT || ${options.port}`,
      ),
    );
  }
  configureE2ePackage(tree, options);
  return callbacks;
}

async function createDelegatedApp(
  tree: Tree,
  options: NormalizedAppOptions,
): Promise<readonly (GeneratorCallback | void)[]> {
  const common = {
    name: options.projectName,
    directory: options.directory,
    scope: options.scope,
    tags: options.tags.join(','),
    skipFormat: true,
  };
  if (options.type === 'worker') {
    return [
      await generator('@megamono/nx-cloudflare', 'workerGenerator')(
        tree,
        common,
      ),
    ];
  }
  if (options.type === 'apple') {
    return [
      await generator('@megamono/nx-apple', 'appleApplicationGenerator')(tree, {
        ...common,
        displayName: options.workspaceName,
        bundleIdentifier: `com.${options.scope}.${options.name}`,
      }),
    ];
  }
  if (options.type === 'extension') {
    return [
      await generator(
        '@megamono/nx-extension',
        'extensionApplicationGenerator',
      )(tree, {
        ...common,
        name: options.name,
        projectName: options.projectName,
        displayName: options.workspaceName,
      }),
    ];
  }
  if (options.type === 'mobile') {
    const callbacks = [
      await generator('@nx/expo', 'expoApplicationGenerator')(tree, {
        ...common,
        e2eTestRunner: 'none',
      }),
    ];
    updatePackage(tree, `${options.directory}/package.json`, options);
    const appSource = `${options.directory}/src/app/App.tsx`;
    if (tree.exists(appSource)) {
      tree.write(
        appSource,
        (tree.read(appSource, 'utf8') ?? '').replace(
          /^\/\* eslint-disable jsx-a11y\/accessible-emoji \*\/\r?\n/,
          '',
        ),
      );
    }
    return callbacks;
  }
  return createDesktopApp(tree, options);
}

function ensureWorkspacePackagePath(
  tree: Tree,
  options: NormalizedAppOptions,
): void {
  if (options.packageManager !== 'pnpm') {
    updateJson(tree, 'package.json', (value: Record<string, unknown>) => {
      const workspaces = value.workspaces;
      if (workspaces !== undefined && !Array.isArray(workspaces)) {
        throw new AppGeneratorError(
          'The workspace uses an unsupported non-array npm workspaces configuration.',
          3,
          'package-manager',
        );
      }
      return {
        ...value,
        workspaces: [...new Set([...(workspaces ?? []), 'apps/*'])].sort(),
      };
    });
    return;
  }
  const path = 'pnpm-workspace.yaml';
  const current = tree.read(path, 'utf8') ?? 'packages:\n';
  if (!/^packages:\s*$/m.test(current)) {
    throw new AppGeneratorError(
      'pnpm-workspace.yaml must contain a packages list.',
      3,
      'package-manager',
    );
  }
  if (!/^\s*-\s*['"]?apps\/\*['"]?\s*$/m.test(current)) {
    tree.write(path, `${current.replace(/\s*$/, '')}\n  - 'apps/*'\n`);
  }
}

function createDesktopApp(
  tree: Tree,
  options: NormalizedAppOptions,
): readonly (GeneratorCallback | void)[] {
  const crateName = options.projectName.replaceAll('-', '_');
  ensureWorkspacePackagePath(tree, options);
  writeJson(tree, `${options.directory}/package.json`, {
    name: options.packageName,
    private: true,
    version: '0.0.0',
    type: 'module',
    nx: {
      name: options.projectName,
      projectType: 'application',
      tags: options.tags,
    },
    scripts: { dev: 'vite', build: 'vite build', tauri: 'tauri' },
    dependencies: {
      '@tauri-apps/api': packageVersion('@tauri-apps/api'),
      '@tauri-apps/plugin-opener': packageVersion('@tauri-apps/plugin-opener'),
    },
    devDependencies: {
      '@tauri-apps/cli': packageVersion('@tauri-apps/cli'),
      typescript: packageVersion('typescript'),
      vite: packageVersion('vite'),
    },
  });
  tree.write(
    `${options.directory}/index.html`,
    '<!doctype html>\n<html><body><main id="app"><h1>Megamono desktop app</h1></main><script type="module" src="/src/main.ts"></script></body></html>\n',
  );
  tree.write(`${options.directory}/src/main.ts`, "import './styles.css';\n");
  tree.write(
    `${options.directory}/src/styles.css`,
    'body { font-family: system-ui, sans-serif; margin: 2rem; }\n',
  );
  tree.write(
    `${options.directory}/src-tauri/build.rs`,
    'fn main() { tauri_build::build() }\n',
  );
  tree.write(
    `${options.directory}/src-tauri/Cargo.toml`,
    `[package]\nname = "${options.projectName}"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\nname = "${crateName}_lib"\ncrate-type = ["staticlib", "cdylib", "rlib"]\n\n[build-dependencies]\ntauri-build = { version = "${rustCrateVersion('tauri-build')}", features = [] }\n\n[dependencies]\ntauri = { version = "${rustCrateVersion('tauri')}", features = [] }\ntauri-plugin-opener = "${rustCrateVersion('tauri-plugin-opener')}"\nserde = { version = "${rustCrateVersion('serde')}", features = ["derive"] }\nserde_json = "${rustCrateVersion('serde_json')}"\n`,
  );
  tree.write(
    `${options.directory}/src-tauri/src/main.rs`,
    `fn main() { ${crateName}_lib::run() }\n`,
  );
  tree.write(
    `${options.directory}/src-tauri/src/lib.rs`,
    `#[cfg_attr(mobile, tauri::mobile_entry_point)]\npub fn run() {\n  tauri::Builder::default()\n    .plugin(tauri_plugin_opener::init())\n    .run(tauri::generate_context!())\n    .expect("error while running tauri application");\n}\n`,
  );
  writeJson(tree, `${options.directory}/src-tauri/tauri.conf.json`, {
    $schema: 'https://schema.tauri.app/config/2',
    productName: options.projectName,
    version: '0.1.0',
    identifier: `com.${options.scope}.${options.name}`,
    build: {
      beforeDevCommand: 'npm run dev',
      devUrl: 'http://localhost:1420',
      beforeBuildCommand: 'npm run build',
      frontendDist: '../dist',
    },
    app: {
      windows: [{ title: options.projectName, width: 800, height: 600 }],
      security: { csp: null },
    },
    bundle: { active: true, targets: 'all' },
  });
  writeJson(tree, `${options.directory}/src-tauri/capabilities/default.json`, {
    $schema: '../gen/schemas/desktop-schema.json',
    identifier: 'default',
    description: 'Default desktop capability',
    windows: ['main'],
    permissions: ['core:default', 'opener:default'],
  });
  updateJson(tree, 'nx.json', (value: Record<string, unknown>) => {
    const plugins = Array.isArray(value.plugins) ? [...value.plugins] : [];
    const next = plugins.filter((entry) =>
      typeof entry === 'string'
        ? entry !== '@megamono/nx-cargo'
        : (entry as { plugin?: unknown }).plugin !== '@megamono/nx-cargo',
    );
    next.push({
      plugin: '@megamono/nx-cargo',
      options: { scope: options.scope, tauriTargetName: 'tauri-build' },
    });
    return { ...value, plugins: next };
  });
  return [];
}

async function confirm(options: AppGeneratorSchema): Promise<boolean> {
  if (options.yes || options.bootstrap) return true;
  if (!canPrompt(options)) {
    throw new AppGeneratorError(
      'Non-interactive application generation requires --yes after all choices are explicit.',
      4,
      'decision-required',
    );
  }
  const answer = await prompt<{ confirmed: boolean }>({
    type: 'confirm',
    name: 'confirmed',
    message: 'Apply this application plan?',
    initial: false,
  });
  return answer.confirmed;
}

export async function appGenerator(
  tree: Tree,
  rawOptions: AppGeneratorSchema,
): Promise<GeneratorCallback> {
  const options = await normalizeOptions(tree, rawOptions);
  if (tree.root !== '/virtual' && !options.dryRun && !options.bootstrap) {
    assertWorkspaceMutationGitPreflight(
      await collectWorkspaceInitHostState(tree.root),
      'Application addition',
    );
  }
  const state = assertProjectPreflight(tree, options);
  logger.info(renderPlan(options));
  if (state === 'noop' || options.dryRun) return () => undefined;
  if (!(await confirm(rawOptions))) return () => undefined;

  const callbacks =
    options.type === 'web' || options.type === 'site'
      ? await createWebApp(tree, options)
      : options.type === 'api'
        ? await createApiApp(tree, options)
        : await createDelegatedApp(tree, options);

  if (!options.bootstrap) {
    updateJson(tree, 'megamono.json', (value: Record<string, unknown>) => ({
      ...value,
      platforms: [
        ...new Set([
          ...((value.platforms as string[] | undefined) ?? []),
          options.platform,
        ]),
      ].sort(),
      ports: {
        ...((value.ports as Record<string, number> | undefined) ?? {}),
        ...(options.port ? { [options.name]: options.port } : {}),
      },
      ...(options.styling
        ? {
            scaffolding: {
              ...((value.scaffolding as Record<string, unknown> | undefined) ??
                {}),
              web: { styling: options.styling },
            },
          }
        : {}),
    }));
  }

  await formatFiles(tree);
  return runTasksInSerial(
    ...callbacks.filter(
      (callback): callback is GeneratorCallback =>
        typeof callback === 'function',
    ),
  );
}

export default appGenerator;
