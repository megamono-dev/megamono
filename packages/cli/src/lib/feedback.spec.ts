import { describe, expect, it } from 'vitest';
import { redactedFeedback } from './feedback.js';

describe('feedback privacy projection', () => {
  it('allows bounded identities but never paths, errors, URLs or arbitrary metadata', () => {
    const secret = 'credential-that-must-not-leak';
    const result = redactedFeedback({
      schemaVersion: 1,
      comparisonScope: 'manifest-and-dist',
      root: `/private/${secret}`,
      store: `/private/store/${secret}`,
      limitations: [secret],
      packages: [
        {
          name: '@megamono/plugin',
          findings: [`https://user:${secret}@example.test`],
          locations: [
            {
              kind: 'installed',
              status: 'present',
              path: `/private/${secret}`,
              error: secret,
              version: '0.1.0-beta.1',
              digest: 'a'.repeat(64),
              build: {
                revision: 'b'.repeat(40),
                buildId: 'c'.repeat(16),
                dirty: false,
                path: secret,
                token: secret,
                nested: { env: secret },
              },
            },
            {
              kind: 'payload',
              status: 'unreadable',
              path: secret,
              error: secret,
              version: `0.0.1+${secret}`,
              digest: secret,
              build: { revision: secret, buildId: secret, dirty: secret },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.packages[0].findingCount).toBe(1);
    expect(result.packages[0].locations[0]).toMatchObject({
      version: '0.1.0-beta.1',
      digest: 'a'.repeat(64),
      revision: 'b'.repeat(40),
      buildId: 'c'.repeat(16),
      dirty: false,
    });
    expect(result.packages[0].locations[1].version).toBeUndefined();
  });
});
