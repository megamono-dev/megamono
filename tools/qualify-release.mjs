import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = (args, env = {}) =>
  execFileSync('npm', args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
const nx = (...args) =>
  npm(['exec', 'nx', '--', ...args, '--output-style=stream']);

npm(['run', 'release:check']);
npm(['run', 'release:test']);
// Generators delegate to other packed workspace packages at runtime. Finish
// every build before tests load those packages from a clean checkout.
nx('run-many', '-t', 'build');
nx('run', 'megamono:check');
nx('run', 'megamono-docs:validate');
nx('run-many', '-t', 'lint', 'test');

// Keep local first-publication and subsequent OIDC releases on the same gates.
for (const target of [
  'nx-apple:e2e-local-registry',
  'nx-cargo:e2e-local-registry',
  'nx-cloudflare:e2e-local-registry',
  'nx-extension:e2e-local-registry',
  '@megamono/cli:e2e-local-packages',
  '@megamono/cli:e2e-ephemeral-survey',
  '@megamono/plugin:e2e-collections-local-registry',
  '@megamono/plugin:e2e-integration-consumer',
  '@megamono/plugin:e2e-prismark-consumer',
  '@megamono/plugin:e2e-governance',
  '@megamono/plugin:e2e-convert-local-registry',
  '@megamono/plugin:e2e-nx-compatibility',
  'nx-phpnative:e2e-php-consumer',
  'create-megamono:e2e-selection-matrix-local-registry',
])
  nx('run', target, '--skip-nx-cache');

npm(
  [
    'exec',
    'nx',
    '--',
    'run',
    'create-megamono:e2e-selection-matrix-local-registry',
    '--skip-nx-cache',
    '--output-style=stream',
  ],
  {
    MEGAMONO_MATRIX_CASES: 'web-npm,api,web-tailwind,web-panda,web-stylex',
    MEGAMONO_MATRIX_VERIFY: 'build',
  },
);
npm(['run', 'packages:check-exports']);
