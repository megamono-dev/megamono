import { builtinModules } from 'node:module';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import ts = require('typescript');

const BUILT_INS = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, '')]),
);
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

export type RuntimeDependencyFindingCode =
  | 'runtime-dependency-dev-only'
  | 'runtime-dependency-missing'
  | 'runtime-analysis-incomplete'
  | 'runtime-output-missing';

export interface RuntimeDependencyFinding {
  readonly code: RuntimeDependencyFindingCode;
  readonly package: string | null;
  readonly severity: 'error';
  readonly evidence: readonly string[];
  readonly message: string;
}

export interface RuntimeDependencyReport {
  readonly schemaVersion: 1;
  readonly project: string;
  readonly outputPath: string;
  readonly manifests: readonly string[];
  readonly externalPackages: readonly string[];
  readonly findings: readonly RuntimeDependencyFinding[];
}

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function filesUnder(path: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await filesUnder(child)));
    else if (entry.isFile() && JAVASCRIPT_EXTENSIONS.has(extname(entry.name)))
      result.push(child);
  }
  return result.sort(compare);
}

function packageName(specifier: string): string | null {
  if (
    !specifier ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('#') ||
    specifier.includes('!') ||
    /^(?:data|file|https?):/.test(specifier)
  )
    return null;
  const normalized = specifier.replace(/^node:/, '');
  if (BUILT_INS.has(normalized)) return null;
  const parts = normalized.split('/');
  return normalized.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function analyzeRuntimeImports(source: string, filename = 'bundle.js') {
  const found = new Set<string>();
  const issues: string[] = [];
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const options: ts.CompilerOptions = {
    allowJs: true,
    noLib: true,
    noResolve: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === filename ? file : undefined);
  host.fileExists = (name) => name === filename;
  host.readFile = (name) => (name === filename ? source : undefined);
  // Binding is local only: never resolve or execute imports in the audited output.
  const program = ts.createProgram([filename], options, host);
  const checker = program.getTypeChecker();
  const declarations = (node: ts.Identifier) =>
    checker.getSymbolAtLocation(node)?.declarations ?? [];
  const globalRequire = (node: ts.Expression) =>
    ts.isIdentifier(node) &&
    node.text === 'require' &&
    !declarations(node).length;
  const nodeModuleImport = (node: ts.Node): boolean => {
    let parent: ts.Node | undefined = node;
    while (parent && !ts.isImportDeclaration(parent)) parent = parent.parent;
    return Boolean(
      parent &&
      ts.isImportDeclaration(parent) &&
      ts.isStringLiteral(parent.moduleSpecifier) &&
      ['module', 'node:module'].includes(parent.moduleSpecifier.text),
    );
  };
  const nodeModuleCall = (node: ts.Expression) =>
    ts.isCallExpression(node) &&
    globalRequire(node.expression) &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]) &&
    ['module', 'node:module'].includes(node.arguments[0].text);
  const createRequireFactory = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node))
      return declarations(node).some(
        (declaration) =>
          (ts.isImportSpecifier(declaration) &&
            (declaration.propertyName ?? declaration.name).text ===
              'createRequire' &&
            nodeModuleImport(declaration)) ||
          (ts.isBindingElement(declaration) &&
            (declaration.propertyName ?? declaration.name).getText(file) ===
              'createRequire' &&
            ts.isVariableDeclaration(declaration.parent.parent) &&
            Boolean(
              declaration.parent.parent.initializer &&
              nodeModuleCall(declaration.parent.parent.initializer),
            )),
      );
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'createRequire'
    )
      return (
        nodeModuleCall(node.expression) ||
        (ts.isIdentifier(node.expression) &&
          declarations(node.expression).some(
            (declaration) =>
              ts.isNamespaceImport(declaration) &&
              nodeModuleImport(declaration),
          ))
      );
    return false;
  };
  const commonJsLoader = (node: ts.Expression): boolean =>
    globalRequire(node) ||
    (ts.isIdentifier(node) &&
      declarations(node).some(
        (declaration) =>
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          ts.isCallExpression(declaration.initializer) &&
          createRequireFactory(declaration.initializer.expression),
      ));
  const location = (position: number) => {
    const { line, character } = file.getLineAndCharacterOfPosition(position);
    return `${line + 1}:${character + 1}`;
  };
  for (const diagnostic of program.getSyntacticDiagnostics(file))
    issues.push(
      `${location(diagnostic.start ?? 0)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    );
  const add = (node: ts.Node | undefined, owner: ts.Node) => {
    if (
      node &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ) {
      const name = packageName(node.text);
      if (name) found.add(name);
    } else {
      issues.push(
        `${location(owner.getStart(file))}: Non-literal module load requires runtime/bundler verification.`,
      );
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier, node);
    } else if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        commonJsLoader(node.expression) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'resolve' &&
          commonJsLoader(node.expression.expression))
      )
        add(node.arguments[0], node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { packages: [...found].sort(compare), issues };
}

export function externalSpecifiers(source: string): readonly string[] {
  const analysis = analyzeRuntimeImports(source);
  if (analysis.issues.length)
    throw new Error(
      `Runtime import analysis is incomplete: ${analysis.issues.join('; ')}`,
    );
  return analysis.packages;
}

async function readManifest(path: string): Promise<PackageManifest | null> {
  if (!(await exists(path))) return null;
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest;
}

export async function verifyRuntimeDependencies(options: {
  readonly workspaceRoot: string;
  readonly project: string;
  readonly projectRoot: string;
  readonly outputPath: string;
}): Promise<RuntimeDependencyReport> {
  const output = resolve(options.workspaceRoot, options.outputPath);
  const rootManifestPath = join(options.workspaceRoot, 'package.json');
  const projectManifestPath = join(
    options.workspaceRoot,
    options.projectRoot,
    'package.json',
  );
  const manifestPaths = [rootManifestPath, projectManifestPath].filter(
    (path, index, paths) => paths.indexOf(path) === index,
  );
  const manifests = (
    await Promise.all(
      manifestPaths.map(async (path) => ({
        path,
        value: await readManifest(path),
      })),
    )
  ).filter(
    (entry): entry is { path: string; value: PackageManifest } =>
      entry.value !== null,
  );
  if (!(await exists(output)))
    return {
      schemaVersion: 1,
      project: options.project,
      outputPath: options.outputPath,
      manifests: manifests.map(({ path }) =>
        relative(options.workspaceRoot, path),
      ),
      externalPackages: [],
      findings: [
        {
          code: 'runtime-output-missing',
          package: null,
          severity: 'error',
          evidence: [options.outputPath],
          message: `Built output ${options.outputPath} does not exist. Build ${options.project} before runtime verification.`,
        },
      ],
    };
  const evidence = new Map<string, Set<string>>();
  const incomplete: RuntimeDependencyFinding[] = [];
  const javascriptFiles = await filesUnder(output);
  if (!javascriptFiles.length)
    incomplete.push({
      code: 'runtime-analysis-incomplete',
      package: null,
      severity: 'error',
      evidence: [options.outputPath],
      message:
        'No JavaScript output files were inspected; check the selected build output path.',
    });
  for (const file of javascriptFiles) {
    const source = await readFile(file, 'utf8');
    const analysis = analyzeRuntimeImports(source, file);
    if (analysis.issues.length)
      incomplete.push({
        code: 'runtime-analysis-incomplete',
        package: null,
        severity: 'error',
        evidence: analysis.issues.map(
          (issue) => `${relative(options.workspaceRoot, file)}:${issue}`,
        ),
        message:
          'Static runtime analysis is incomplete; verify unresolved loads or invalid output before treating this report as passing.',
      });
    for (const dependency of analysis.packages) {
      const paths = evidence.get(dependency) ?? new Set<string>();
      paths.add(relative(options.workspaceRoot, file));
      evidence.set(dependency, paths);
    }
  }
  const production = new Set<string>();
  const development = new Set<string>();
  for (const { value } of manifests) {
    for (const name of Object.keys(value.dependencies ?? {}))
      production.add(name);
    for (const name of Object.keys(value.optionalDependencies ?? {}))
      production.add(name);
    for (const name of Object.keys(value.devDependencies ?? {}))
      development.add(name);
  }
  const findings = [...evidence.entries()].flatMap(([name, paths]) => {
    if (production.has(name)) return [];
    const devOnly = development.has(name);
    return [
      {
        code: devOnly
          ? ('runtime-dependency-dev-only' as const)
          : ('runtime-dependency-missing' as const),
        package: name,
        severity: 'error' as const,
        evidence: [...paths].sort(compare),
        message: devOnly
          ? `${name} is required by the built output but is declared only in devDependencies.`
          : `${name} is required by the built output but is not a production dependency of the workspace or project.`,
      },
    ];
  });
  return {
    schemaVersion: 1,
    project: options.project,
    outputPath: options.outputPath,
    manifests: manifests.map(({ path }) =>
      relative(options.workspaceRoot, path),
    ),
    externalPackages: [...evidence.keys()].sort(compare),
    findings: [...findings, ...incomplete].sort(
      (left, right) =>
        compare(left.package ?? '', right.package ?? '') ||
        compare(left.code, right.code),
    ),
  };
}

export function serializeRuntimeDependencyReport(
  report: RuntimeDependencyReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
