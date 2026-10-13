import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validatePublishingSetup } from './check-publishing-setup.mjs';

const policy = JSON.parse(
  await readFile(new URL('./publishing-policy.json', import.meta.url), 'utf8'),
);
function configured() {
  return {
    repository: { full_name: policy.repository, visibility: 'public' },
    environments: Object.fromEntries(
      Object.entries(policy.environments).map(([name, expected]) => [
        name,
        {
          environment: {
            deployment_branch_policy: {
              protected_branches: false,
              custom_branch_policies: true,
            },
            protection_rules: [
              {
                type: 'required_reviewers',
                reviewers: expected.requiredReviewers.map((login) => ({
                  type: 'User',
                  reviewer: { login },
                })),
              },
            ],
          },
          branches: {
            branch_policies: expected.branches.map((name) => ({
              name,
              type: 'branch',
            })),
          },
        },
      ]),
    ),
  };
}
test('accepts the configured public repository and protected release channels', () => {
  assert.doesNotThrow(() => validatePublishingSetup(policy, configured()));
});
test('rejects missing environments, private source, and unrestricted deployments', () => {
  const snapshot = configured();
  snapshot.repository.visibility = 'private';
  delete snapshot.environments['npm-next'];
  snapshot.environments['npm-latest'].environment.deployment_branch_policy =
    null;
  assert.throws(
    () => validatePublishingSetup(policy, snapshot),
    /Publishing setup is incomplete/,
  );
});
test('rejects extra branch or tag permissions on the stable channel', () => {
  for (const type of ['branch', 'tag']) {
    const snapshot = configured();
    snapshot.environments['npm-latest'].branches.branch_policies.push({
      name: '*',
      type,
    });
    assert.throws(
      () => validatePublishingSetup(policy, snapshot),
      /must allow only branches main/,
    );
  }
});
test('rejects stable publishing without its required maintainer review', () => {
  const snapshot = configured();
  snapshot.environments['npm-latest'].environment.protection_rules = [];
  assert.throws(
    () => validatePublishingSetup(policy, snapshot),
    /requires approval from ryanhefner/,
  );
});
