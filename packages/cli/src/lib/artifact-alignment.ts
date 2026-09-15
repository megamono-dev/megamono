import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const DEFAULT_ARTIFACT_MANIFEST =
  '.megamono/qualification-artifacts.json';
const LIMIT = 128 * 1024 * 1024;
const namePattern =
  /^(?:@(?:megamono|playstack)\/[a-z0-9._-]+|create-megamono)$/;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

function inside(root: string, file: string) {
  const rel = relative(realpathSync(root), realpathSync(file));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../'))
    throw new Error(
      'Selected artifacts and consumer manifests must remain inside the workspace.',
    );
}
function boundedRead(file: string): Buffer {
  if (!statSync(file).isFile() || statSync(file).size > LIMIT)
    throw new Error('Artifact file is not a bounded regular file.');
  return readFileSync(file);
}

/** Read a bounded npm tarball in memory. Never extract paths or execute scripts. */
export function archiveFiles(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length > LIMIT) throw new Error('Archive exceeds the size limit.');
  const tar = gunzipSync(bytes, { maxOutputLength: LIMIT });
  const files = new Map<string, Buffer>();
  let paxPath: string | undefined;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .split('\0')[0];
    const octal = (value: string) => {
      if (!/^[ 0-7]*$/.test(value))
        throw new Error('Unsupported archive number.');
      return parseInt(value.trim() || '0', 8);
    };
    const checksum = [...header].reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (octal(field(148, 8)) !== checksum)
      throw new Error('Invalid archive checksum.');
    const size = octal(field(124, 12));
    if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length)
      throw new Error('Truncated archive.');
    const data = tar.subarray(offset + 512, offset + 512 + size);
    const type = field(156, 1);
    let path =
      paxPath ?? [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    paxPath = undefined;
    if (type === 'x') {
      for (let cursor = 0; cursor < data.length;) {
        const space = data.indexOf(32, cursor);
        const length = Number(data.subarray(cursor, space).toString());
        if (
          space < cursor ||
          !Number.isSafeInteger(length) ||
          length <= space - cursor + 1 ||
          cursor + length > data.length
        )
          throw new Error('Invalid archive extension.');
        const record = data
          .subarray(space + 1, cursor + length)
          .toString('utf8')
          .replace(/\n$/, '');
        const key = record.slice(0, record.indexOf('='));
        if (key === 'path') paxPath = record.slice(5);
        else if (
          !['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(
            key,
          )
        )
          throw new Error('Unsupported archive extension.');
        cursor += length;
      }
    } else {
      path = path.replace(/\/$/, '');
      if (
        !path.startsWith('package/') ||
        path.includes('\\') ||
        path.split('/').some((part) => !part || part === '.' || part === '..')
      ) {
        if (!(type === '5' && path === 'package'))
          throw new Error('Unsafe archive path.');
      }
      if (type === '' || type === '0') {
        const key = path.slice(8);
        if (files.has(key) || files.size >= 50000)
          throw new Error('Duplicate or excessive archive entries.');
        files.set(key, data);
      } else if (type !== '5')
        throw new Error('Archive links and special entries are not supported.');
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!files.has('package.json'))
    throw new Error('Archive has no package manifest.');
  return files;
}

function directoryFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let size = 0;
  function walk(dir: string) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (
        ['node_modules', '.git', '.yalc.sig'].includes(entry.name) ||
        entry.name.endsWith('.tsbuildinfo')
      )
        continue;
      const key = join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new Error('Selected artifacts cannot contain symlinks.');
      if (entry.isDirectory()) walk(key);
      else if (entry.isFile()) {
        const bytes = boundedRead(join(root, key));
        size += bytes.length;
        if (size > LIMIT || files.size >= 50000)
          throw new Error('Artifact exceeds inspection limits.');
        files.set(key, bytes);
      }
    }
  }
  walk('');
  return files;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object'
    ? Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, val]) => [key, canonical(val)]),
      )
    : value;
}
function manifestBytes(bytes: Buffer): Buffer {
  const manifest = JSON.parse(bytes.toString());
  for (const field of ['yalcSig', '_id', '_from', '_resolved', '_integrity'])
    delete manifest[field];
  return Buffer.from(JSON.stringify(canonical(manifest)));
}

function installedDirectory(consumerManifest: string, name: string): string {
  const resolver = createRequire(consumerManifest);
  // A package need not export package.json. Resolve its physical Node search
  // location without loading an entry point or skipping a nearer installation.
  for (const search of resolver.resolve.paths(name) ?? []) {
    const directory = join(search, name);
    if (existsSync(join(directory, 'package.json'))) return directory;
  }
  throw new Error('No installed package resolves for this consumer.');
}

export function verifyArtifactAlignment(
  root: string,
  manifestPath = DEFAULT_ARTIFACT_MANIFEST,
) {
  const manifestFile = resolve(root, manifestPath);
  inside(root, manifestFile);
  const manifest = json(manifestFile);
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.artifacts) ||
    !manifest.artifacts.length ||
    manifest.artifacts.length > 500
  )
    throw new Error(
      'Expected a version 1 qualification manifest with 1–500 artifact selections.',
    );
  const results = manifest.artifacts.map(
    (entry: {
      package?: string;
      from?: string;
      consumer?: string;
      sha256?: string;
    }) => {
      if (
        !entry ||
        typeof entry.package !== 'string' ||
        !namePattern.test(entry.package) ||
        typeof entry.from !== 'string' ||
        isAbsolute(entry.from) ||
        (entry.consumer !== undefined &&
          (typeof entry.consumer !== 'string' || isAbsolute(entry.consumer)))
      )
        throw new Error(
          'Invalid artifact selection: use a package name and workspace-relative from/consumer paths.',
        );
      const consumer = entry.consumer ?? '.';
      const result: {
        package: string;
        consumer: string;
        status: 'aligned' | 'mismatch' | 'unverifiable';
        digest?: string;
        reason?: string;
      } = { package: entry.package, consumer, status: 'unverifiable' };
      try {
        const from = resolve(root, entry.from);
        inside(root, from);
        const consumerManifest = resolve(root, consumer, 'package.json');
        inside(root, consumerManifest);
        const source = statSync(from).isDirectory()
          ? directoryFiles(from)
          : archiveFiles(boundedRead(from));
        if (
          entry.sha256 !== undefined &&
          (!/^[a-f0-9]{64}$/.test(entry.sha256) ||
            statSync(from).isDirectory() ||
            sha(boundedRead(from)) !== entry.sha256)
        )
          throw new Error('Selected archive checksum does not match.');
        const selectedManifest = source.get('package.json');
        if (
          !selectedManifest ||
          JSON.parse(selectedManifest.toString()).name !== entry.package
        )
          throw new Error('Selected package identity does not match.');
        const installed = installedDirectory(consumerManifest, entry.package);
        const hash = createHash('sha256');
        let mismatch = false;
        for (const [file, bytes] of [...source.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          if (file === '.yalc.sig' || file.endsWith('.tsbuildinfo')) continue;
          const expected =
            file === 'package.json' ? manifestBytes(bytes) : bytes;
          hash.update(JSON.stringify([file, expected.length]));
          hash.update(expected);
          const actualFile = join(installed, file);
          if (!existsSync(actualFile)) {
            mismatch = true;
            continue;
          }
          inside(installed, actualFile);
          if (lstatSync(actualFile).isSymbolicLink())
            throw new Error(
              'Installed artifact contains an unsupported symlink.',
            );
          const actualBytes = boundedRead(actualFile);
          const actual =
            file === 'package.json' ? manifestBytes(actualBytes) : actualBytes;
          if (!expected.equals(actual)) mismatch = true;
        }
        result.digest = hash.digest('hex');
        result.status = mismatch ? 'mismatch' : 'aligned';
        if (mismatch)
          result.reason =
            'Installed files differ from the selected artifact. Reconcile explicitly before qualification.';
      } catch {
        result.reason =
          'Selection could not be verified (missing, unreadable, unsafe, unsupported, or checksum/identity mismatch). Review the local manifest and installation.';
      }
      return result;
    },
  );
  return {
    schemaVersion: 1,
    aligned: results.every(
      (entry: { status: string }) => entry.status === 'aligned',
    ),
    artifacts: results,
    limitations: [
      'Only explicitly selected consumer/artifact pairs were compared. No store or PATH version is required.',
      'Compares selected files; additional installation-generated files are not qualification of runtime behavior.',
      'No installation, extraction, provider calls, or package scripts were performed.',
    ],
  };
}
