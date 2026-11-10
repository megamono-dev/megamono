type GitOutput = (args: readonly string[]) => Promise<string | undefined>;

/** Keep CLI preflight independent of the optional plugin installation. */
export async function resolveDefaultBranch(
  output: GitOutput,
): Promise<string | undefined> {
  const validBranch = async (name: string | undefined) =>
    name &&
    (await output(['check-ref-format', `refs/heads/${name}`])) !== undefined
      ? name
      : undefined;
  const tracked = await output([
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  const localDefault = tracked?.startsWith('origin/')
    ? await validBranch(tracked.slice('origin/'.length))
    : undefined;
  if (localDefault) return localDefault;
  if (await output(['remote', 'get-url', 'origin'])) {
    const advertised = await output([
      'ls-remote',
      '--symref',
      'origin',
      'HEAD',
    ]);
    const remoteDefault = await validBranch(
      /^ref: refs\/heads\/([^\t\r\n]+)\tHEAD$/m.exec(advertised ?? '')?.[1],
    );
    if (remoteDefault) return remoteDefault;
  }
  return validBranch(await output(['config', '--get', 'init.defaultBranch']));
}
