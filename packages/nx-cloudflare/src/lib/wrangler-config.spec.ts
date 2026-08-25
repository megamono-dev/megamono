import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { collectWranglerConfigs, parseWranglerConfig } from './wrangler-config';

describe('parseWranglerConfig', () => {
  it('parses JSONC comments, trailing commas, and unknown keys', () => {
    const parsed = parseWranglerConfig(
      `{
        // Wrangler permits comments.
        "name": "api",
        "compatibility_date": "2026-08-23",
        "future_binding": { "enabled": true },
      }`,
      'apps/api/wrangler.jsonc',
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.config).toMatchObject({
      name: 'api',
      future_binding: { enabled: true },
    });
  });

  it('parses TOML as a first-class format', () => {
    const parsed = parseWranglerConfig(
      `name = "jobs"
main = "src/index.ts"
compatibility_date = "2026-08-23"

[[services]]
binding = "API"
service = "api"
`,
      'apps/jobs/wrangler.toml',
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.config).toMatchObject({
      name: 'jobs',
      services: [{ binding: 'API', service: 'api' }],
    });
  });

  it('degrades malformed configs and unsupported Pages configs to diagnostics', () => {
    expect(
      parseWranglerConfig('{ "name":', 'apps/bad/wrangler.jsonc'),
    ).toMatchObject({
      diagnostics: [{ code: 'cloudflare-config-parse' }],
    });
    expect(
      parseWranglerConfig(
        '{ "pages_build_output_dir": "dist" }',
        'apps/site/wrangler.json',
      ),
    ).toMatchObject({
      diagnostics: [{ code: 'cloudflare-pages-unsupported' }],
    });
  });
});

describe('collectWranglerConfigs', () => {
  it('selects one explicit config when a directory contains several', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'nx-cloudflare-config-'));
    await mkdir(resolve(root, 'apps/api'), { recursive: true });
    await Promise.all([
      writeFile(resolve(root, 'apps/api/wrangler.json'), '{"name":"json"}'),
      writeFile(resolve(root, 'apps/api/wrangler.jsonc'), '{"name":"jsonc"}'),
    ]);
    const files = ['apps/api/wrangler.json', 'apps/api/wrangler.jsonc'];
    const [collision] = await collectWranglerConfigs(files, root);
    expect(collision).toMatchObject({
      root: 'apps/api',
      executable: false,
      diagnostics: [{ code: 'cloudflare-config-collision' }],
    });

    const [selected] = await collectWranglerConfigs(files, root, {
      configPath: './apps/api/wrangler.jsonc',
    });
    expect(selected).toMatchObject({
      configPath: 'apps/api/wrangler.jsonc',
      executable: true,
      config: { name: 'jsonc' },
      diagnostics: [],
    });
  });

  it('keeps valid projects when another config is malformed', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'nx-cloudflare-mixed-'));
    await Promise.all([
      mkdir(resolve(root, 'apps/good'), { recursive: true }),
      mkdir(resolve(root, 'apps/bad'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(resolve(root, 'apps/good/wrangler.jsonc'), '{"name":"good"}'),
      writeFile(resolve(root, 'apps/bad/wrangler.toml'), 'name = ['),
    ]);
    const records = await collectWranglerConfigs(
      ['apps/good/wrangler.jsonc', 'apps/bad/wrangler.toml'],
      root,
    );
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.root === 'apps/good')).toMatchObject(
      {
        executable: true,
      },
    );
    expect(records.find((record) => record.root === 'apps/bad')).toMatchObject({
      executable: false,
      diagnostics: [{ code: 'cloudflare-config-parse' }],
    });
  });
});
