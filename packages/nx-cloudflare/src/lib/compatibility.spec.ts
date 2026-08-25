import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CLOUDFLARE_COMPATIBILITY_DATE,
  CLOUDFLARE_NODE_COMPATIBILITY_DEFAULT_DATE,
  CREATE_CLOUDFLARE_VERSION,
  WRANGLER_VERSION,
  WRANGLER_VERSION_RANGE,
} from './compatibility';

describe('Cloudflare compatibility', () => {
  it('stays aligned with the canonical compatibility registry', () => {
    const registry = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../../../plugin/compatibility.json'),
        'utf8',
      ),
    ) as {
      scaffoldPackages: Record<string, string>;
      cloudflare: {
        wrangler: string;
        compatibilityDate: string;
        nodeCompatibilityDefaultDate: string;
      };
    };

    expect(CREATE_CLOUDFLARE_VERSION).toBe(
      registry.scaffoldPackages['create-cloudflare'],
    );
    expect(WRANGLER_VERSION).toBe(registry.scaffoldPackages.wrangler);
    expect(WRANGLER_VERSION_RANGE).toBe(registry.cloudflare.wrangler);
    expect(CLOUDFLARE_COMPATIBILITY_DATE).toBe(
      registry.cloudflare.compatibilityDate,
    );
    expect(CLOUDFLARE_NODE_COMPATIBILITY_DEFAULT_DATE).toBe(
      registry.cloudflare.nodeCompatibilityDefaultDate,
    );
  });
});
