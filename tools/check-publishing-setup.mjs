import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function validatePublishingSetup(policy, snapshot) {
  const failures = [];
  if (
    snapshot.repository?.full_name !== policy.repository ||
    snapshot.repository?.visibility !== policy.visibility
  )
    failures.push(
      `Expected the ${policy.visibility} repository ${policy.repository}.`,
    );
  for (const [name, expected] of Object.entries(policy.environments)) {
    const actual = snapshot.environments?.[name];
    if (!actual) {
      failures.push(`Missing protected environment ${name}.`);
      continue;
    }
    if (
      actual.environment.deployment_branch_policy?.custom_branch_policies !==
        true ||
      actual.environment.deployment_branch_policy?.protected_branches !== false
    )
      failures.push(`${name} must use explicit deployment branch policies.`);
    const branches = actual.branches.branch_policies ?? [];
    if (
      branches.some((branch) => (branch.type ?? 'branch') !== 'branch') ||
      JSON.stringify(branches.map((branch) => branch.name).sort()) !==
        JSON.stringify([...expected.branches].sort())
    )
      failures.push(
        `${name} must allow only branches ${expected.branches.join(', ')}.`,
      );
    const reviewRule = actual.environment.protection_rules?.find(
      (rule) => rule.type === 'required_reviewers',
    );
    const reviewers = (reviewRule?.reviewers ?? []).map(
      (entry) => entry.reviewer.login,
    );
    if (expected.requiredReviewers.some((login) => !reviewers.includes(login)))
      failures.push(
        `${name} requires approval from ${expected.requiredReviewers.join(', ')}.`,
      );
  }
  if (failures.length)
    throw new Error(
      `Publishing setup is incomplete:\n- ${failures.join('\n- ')}`,
    );
}

async function main() {
  const policy = JSON.parse(
    await readFile(
      new URL('./publishing-policy.json', import.meta.url),
      'utf8',
    ),
  );
  const api = (path) =>
    JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
  const base = `repos/${policy.repository}`;
  const snapshot = { repository: api(base), environments: {} };
  for (const name of Object.keys(policy.environments)) {
    const endpoint = `${base}/environments/${name}`;
    snapshot.environments[name] = {
      environment: api(endpoint),
      branches: api(`${endpoint}/deployment-branch-policies`),
    };
  }
  validatePublishingSetup(policy, snapshot);
  console.log(`Publishing protections verified for ${policy.repository}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
