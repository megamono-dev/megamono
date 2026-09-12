/** Tauri's native host and browser frontend share one Nx application root. */
export function isTauriProject(
  root: string,
  exists: (path: string) => boolean,
): boolean {
  return (
    exists(`${root}/src-tauri/Cargo.toml`) &&
    ['tauri.conf.json', 'tauri.conf.json5', 'Tauri.toml'].some((name) =>
      exists(`${root}/src-tauri/${name}`),
    )
  );
}

/** Only root-level, known build/test configuration runs in Node. */
export function tauriFilePlatform(
  relativePath: string,
): 'rust' | 'web' | 'node' {
  if (relativePath.startsWith('src-tauri/')) return 'rust';
  if (
    /^(?:vite|vitest|playwright|eslint)\.config\.[cm]?[jt]s$/.test(relativePath)
  )
    return 'node';
  return 'web';
}
