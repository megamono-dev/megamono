import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import ts = require('typescript');

export interface WebpackRuntimeEvidence {
  readonly schemaVersion: 1;
  readonly kind: 'webpack-node-chunks';
  readonly webpackVersion: string;
  readonly compilationHash: string;
  readonly assets: Readonly<Record<string, string>>;
  readonly chunks: Readonly<Record<string, readonly string[]>>;
}

const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const javascript = (name: string) => /\.(?:c|m)?js$/.test(name);
function safeName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !name.includes(':') &&
    !name.startsWith('/') &&
    name
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an evidence object.');
  return value as Record<string, unknown>;
}
async function assetBytes(output: string, name: string): Promise<Buffer> {
  if (!safeName(name)) throw new Error(`Unsafe asset path: ${name}`);
  let current = resolve(output);
  if (
    !(await lstat(current)).isDirectory() ||
    (await lstat(current)).isSymbolicLink()
  )
    throw new Error('Output must be a real directory.');
  for (const part of name.split('/')) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error(`Symlink asset path: ${name}`);
  }
  if (!(await lstat(current)).isFile())
    throw new Error(`Asset is not a file: ${name}`);
  return readFile(current);
}

/** Call after a successful Webpack build, with stats.toJson({all:false,
 * version:true, hash:true, errors:true, assets:true, chunks:true, ids:true}).
 * This records build evidence, not a runtime smoke test or trusted-code signature.
 */
export async function createWebpackRuntimeEvidence(options: {
  readonly outputPath: string;
  readonly stats: unknown;
}): Promise<WebpackRuntimeEvidence> {
  const stats = object(options.stats);
  if (
    typeof stats.version !== 'string' ||
    !stats.version.startsWith('5.') ||
    typeof stats.hash !== 'string' ||
    !stats.hash ||
    !Array.isArray(stats.errors) ||
    stats.errors.length ||
    !Array.isArray(stats.assets) ||
    !Array.isArray(stats.chunks) ||
    stats.children
  ) {
    throw new Error(
      'Require complete, successful single-compilation Webpack 5 stats (version, hash, errors, assets, chunks, ids).',
    );
  }
  const assets: Record<string, string> = Object.create(null);
  for (const entry of stats.assets) {
    const asset = object(entry);
    if (!safeName(asset.name))
      throw new Error(
        'Unsafe or grouped stats asset; request ungrouped assets.',
      );
    if (!javascript(asset.name)) continue;
    if (asset.name in assets) throw new Error('Duplicate stats asset.');
    const bytes = await assetBytes(options.outputPath, asset.name);
    if (asset.size !== bytes.length)
      throw new Error(`Stats/asset size mismatch: ${asset.name}`);
    assets[asset.name] = sha256(bytes);
  }
  const chunks: Record<string, string[]> = Object.create(null);
  for (const entry of stats.chunks) {
    const chunk = object(entry);
    if (
      !['string', 'number'].includes(typeof chunk.id) ||
      !Array.isArray(chunk.files)
    )
      throw new Error('Stats require chunk IDs and files.');
    const id = String(chunk.id);
    if (
      id in chunks ||
      !id ||
      ['__proto__', 'constructor', 'prototype'].includes(id)
    )
      throw new Error('Invalid/duplicate chunk ID.');
    const files: string[] = [];
    for (const name of chunk.files) {
      if (!safeName(name)) throw new Error('Unsafe chunk path.');
      if (javascript(name)) {
        if (!(name in assets))
          throw new Error(`Chunk asset missing from stats: ${name}`);
        files.push(name);
      }
    }
    chunks[id] = files;
  }
  if (!Object.keys(assets).length || !Object.keys(chunks).length)
    throw new Error('Empty Webpack JavaScript evidence.');
  return {
    schemaVersion: 1,
    kind: 'webpack-node-chunks',
    webpackVersion: stats.version,
    compilationHash: stats.hash,
    assets,
    chunks,
  };
}

export async function validateWebpackRuntimeEvidence(
  value: unknown,
  output: string,
  javascriptFiles: readonly string[],
): Promise<WebpackRuntimeEvidence> {
  const data = object(value);
  if (
    data.schemaVersion !== 1 ||
    data.kind !== 'webpack-node-chunks' ||
    typeof data.webpackVersion !== 'string' ||
    !data.webpackVersion.startsWith('5.') ||
    typeof data.compilationHash !== 'string' ||
    !data.compilationHash
  )
    throw new Error('Unsupported Webpack evidence.');
  const assets = object(data.assets),
    chunks = object(data.chunks);
  const actual = javascriptFiles
    .map((file) => relative(output, file).split('\\').join('/'))
    .sort();
  if (
    !actual.length ||
    JSON.stringify(actual) !== JSON.stringify(Object.keys(assets).sort())
  )
    throw new Error(
      'Evidence must cover exactly all emitted JavaScript files.',
    );
  for (const [name, hash] of Object.entries(assets)) {
    if (
      !safeName(name) ||
      typeof hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      sha256(await assetBytes(output, name)) !== hash
    )
      throw new Error(`Stale or invalid asset evidence: ${name}`);
  }
  if (!Object.keys(chunks).length)
    throw new Error('Evidence has no chunk graph.');
  for (const [id, files] of Object.entries(chunks)) {
    if (
      !id ||
      ['__proto__', 'constructor', 'prototype'].includes(id) ||
      !Array.isArray(files) ||
      files.some((name) => !safeName(name) || !Object.hasOwn(assets, name))
    )
      throw new Error('Invalid chunk graph.');
  }
  return data as unknown as WebpackRuntimeEvidence;
}

// Tiny non-executing evaluator for Webpack's unminified filename getter.
// No eval, function invocation, globals, getters, or arbitrary property access.
function filenameValue(
  node: ts.Expression,
  parameter: string,
  id: string | number,
): string | number {
  if (ts.isParenthesizedExpression(node))
    return filenameValue(node.expression, parameter, id);
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node))
    return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
  if (ts.isIdentifier(node) && node.text === parameter) return id;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = filenameValue(node.left, parameter, id),
      right = filenameValue(node.right, parameter, id);
    return typeof left === 'number' && typeof right === 'number'
      ? left + right
      : String(left) + String(right);
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isObjectLiteralExpression(node.expression)
  ) {
    const key = String(filenameValue(node.argumentExpression, parameter, id));
    const properties = node.expression.properties;
    if (
      properties.some(
        (p) =>
          !ts.isPropertyAssignment(p) ||
          !(ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)),
      )
    )
      throw new Error('Unsupported filename map.');
    const matches = properties.filter(
      (p) =>
        ts.isPropertyAssignment(p) && (p.name as ts.StringLiteral).text === key,
    );
    if (matches.length !== 1 || !ts.isPropertyAssignment(matches[0]))
      throw new Error('Unresolved filename map key.');
    return filenameValue(matches[0].initializer, parameter, id);
  }
  throw new Error('Unsupported Webpack filename expression.');
}

/** Qualifies only the standard unminified Webpack 5 synchronous Node loader.
 * Other loaders, mutable filename getters, dynamic ensure calls and HMR stay open.
 */
export function webpackChunkLoadOffsets(
  source: string,
  asset: string,
  evidence: WebpackRuntimeEvidence,
): ReadonlySet<number> {
  const file = ts.createSourceFile(
    asset,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const nodes: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    nodes.push(n);
    ts.forEachChild(n, visit);
  };
  visit(file);
  if (
    nodes.some(
      (n) =>
        (ts.isElementAccessExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === '__webpack_require__') ||
        (ts.isVariableDeclaration(n) &&
          n.initializer &&
          ts.isIdentifier(n.initializer) &&
          n.initializer.text === '__webpack_require__') ||
        (ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          ts.isIdentifier(n.expression.expression) &&
          ['Object', 'Reflect'].includes(n.expression.expression.text) &&
          n.arguments.some(
            (arg) => ts.isIdentifier(arg) && arg.text === '__webpack_require__',
          )),
    )
  )
    return new Set();
  const property = (n: ts.Node, text: string) =>
    ts.isPropertyAccessExpression(n) &&
    n.getText(file).replace(/\s/g, '') === text;
  const getters = nodes.filter(
    (n): n is ts.BinaryExpression =>
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      property(n.left, '__webpack_require__.u'),
  );
  if (getters.length !== 1) return new Set();
  if (
    nodes.filter((n) => property(n, '__webpack_require__.f.require')).length !==
    1
  )
    return new Set();
  const getter = getters[0].right;
  if (
    !(ts.isArrowFunction(getter) || ts.isFunctionExpression(getter)) ||
    getter.parameters.length !== 1 ||
    !ts.isIdentifier(getter.parameters[0].name) ||
    !getter.body
  )
    return new Set();
  const body = getter.body;
  const expression = ts.isBlock(body)
    ? body.statements.length === 1 && ts.isReturnStatement(body.statements[0])
      ? body.statements[0].expression
      : undefined
    : body;
  if (!expression) return new Set();
  const parameter = getter.parameters[0].name.text;
  // Every generated ensure call must identify a known chunk statically.
  const ensureRefs = nodes.filter((n) => property(n, '__webpack_require__.e'));
  const ensureDefinitions = ensureRefs.filter(
    (n) =>
      ts.isBinaryExpression(n.parent) &&
      n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      n.parent.left === n &&
      (ts.isArrowFunction(n.parent.right) ||
        ts.isFunctionExpression(n.parent.right)),
  );
  if (ensureDefinitions.length > 1) return new Set();
  const ensures = ensureRefs.filter((n) => !ensureDefinitions.includes(n));
  if (
    !ensures.length ||
    ensures.some(
      (n) =>
        !ts.isCallExpression(n.parent) ||
        n.parent.expression !== n ||
        n.parent.arguments.length !== 1 ||
        !(
          ts.isStringLiteral(n.parent.arguments[0]) ||
          ts.isNumericLiteral(n.parent.arguments[0])
        ) ||
        !Object.hasOwn(evidence.chunks, n.parent.arguments[0].text),
    )
  )
    return new Set();
  // The filename getter may only be assigned once and called by this loader.
  const getterRefs = nodes.filter((n) => property(n, '__webpack_require__.u'));
  if (
    getterRefs.some(
      (n) =>
        n !== getters[0].left &&
        !(ts.isCallExpression(n.parent) && n.parent.expression === n),
    )
  )
    return new Set();
  const offsets = new Set<number>();
  for (const node of nodes) {
    if (
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      node.expression.text !== 'require' ||
      node.arguments.length !== 1
    )
      continue;
    const argument = node.arguments[0];
    if (
      !ts.isBinaryExpression(argument) ||
      argument.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
      !ts.isStringLiteral(argument.left) ||
      argument.left.text !== './' ||
      !ts.isCallExpression(argument.right) ||
      !property(argument.right.expression, '__webpack_require__.u') ||
      argument.right.arguments.length !== 1 ||
      !ts.isIdentifier(argument.right.arguments[0])
    )
      continue;
    let owner: ts.Node | undefined = node.parent;
    while (
      owner &&
      !ts.isArrowFunction(owner) &&
      !ts.isFunctionExpression(owner) &&
      !ts.isFunctionDeclaration(owner)
    )
      owner = owner.parent;
    if (
      !owner ||
      !(ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) ||
      owner.parameters.length !== 2 ||
      !ts.isIdentifier(owner.parameters[0].name) ||
      owner.parameters[0].name.text !== argument.right.arguments[0].text ||
      !ts.isBinaryExpression(owner.parent) ||
      owner.parent.right !== owner ||
      !property(owner.parent.left, '__webpack_require__.f.require')
    )
      continue;
    // Parameter reassignment would invalidate the finite set of ensure IDs.
    const chunkParameter = owner.parameters[0].name.text;
    const mutable = (n: ts.Node): boolean => {
      if (
        ts.isBinaryExpression(n) &&
        ts.isIdentifier(n.left) &&
        n.left.text === chunkParameter &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        return true;
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        ts.isIdentifier(n.operand) &&
        n.operand.text === chunkParameter &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
          n.operator,
        )
      )
        return true;
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === chunkParameter
      )
        return true;
      return ts.forEachChild(n, mutable) ?? false;
    };
    if (mutable(owner.body)) continue;
    try {
      for (const ensure of ensures) {
        const call = ensure.parent as ts.CallExpression;
        const id = (call.arguments[0] as ts.StringLiteral).text;
        const name = String(
          filenameValue(
            expression,
            parameter,
            ts.isNumericLiteral(call.arguments[0]) ? Number(id) : id,
          ),
        );
        if (!safeName(name)) throw new Error('Unsafe filename.');
        const target = posix.join(dirname(asset).split('\\').join('/'), name);
        if (
          !evidence.chunks[id].includes(target) ||
          !Object.hasOwn(evidence.assets, target)
        )
          throw new Error('Chunk filename does not match graph.');
      }
      offsets.add(node.getStart(file));
    } catch {
      /* Unsupported getter or incomplete chunk graph stays unresolved. */
    }
  }
  return offsets.size + 1 === getterRefs.length ? offsets : new Set();
}
