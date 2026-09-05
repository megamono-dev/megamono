import type { ProjectConfiguration, Tree } from '@nx/devkit';
import { posix } from 'node:path';
import ts = require('typescript');
import { z } from 'zod';
import { integrationFingerprint } from './integration-migrations';

const symbol = z.string().regex(/^[A-Za-z_$][\w$]*$/);
const schema = z
  .object({
    project: z.string().min(1),
    modules: z
      .array(z.object({ file: z.string(), export: symbol }).strict())
      .min(1),
    connect: z
      .object({
        file: z.string(),
        module: symbol,
        importPath: z.string().regex(/^[@\w][\w@/.-]*$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export const COMPOSITION_STATE = '.megamono/playstack-compositions.json';
const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  })
  .strict();

function safe(path: string) {
  if (
    /^(?:\/|[A-Za-z]:)/.test(path) ||
    path.includes('\\') ||
    path.split('/').some((p) => !p || p === '.' || p === '..') ||
    path.split('/').includes('node_modules')
  )
    throw new Error(`Unsafe composition path: ${path}.`);
  return path;
}
function nestModule(
  source: ts.SourceFile,
  name: string,
): ts.ObjectLiteralExpression {
  const aliases = source.statements
    .filter(ts.isImportDeclaration)
    .filter(
      (s) =>
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === '@nestjs/common',
    )
    .flatMap((s) => {
      const bindings = s.importClause?.namedBindings;
      return bindings && ts.isNamedImports(bindings)
        ? bindings.elements
            .filter((e) => (e.propertyName ?? e.name).text === 'Module')
            .map((e) => e.name.text)
        : [];
    });
  const declaration = source.statements.find(
    (s): s is ts.ClassDeclaration =>
      ts.isClassDeclaration(s) && s.name?.text === name,
  );
  for (const decorator of declaration
    ? (ts.getDecorators(declaration) ?? [])
    : []) {
    const expression = decorator.expression;
    if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      aliases.includes(expression.expression.text) &&
      expression.arguments.length === 1 &&
      ts.isObjectLiteralExpression(expression.arguments[0])
    )
      return expression.arguments[0];
  }
  throw new Error(
    `${source.fileName} must declare ${name} with a static Nest @Module({...}).`,
  );
}
function exportedModule(file: string, content: string, name: string) {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  nestModule(source, name);
  if (
    !source.statements.some(
      (s) =>
        ts.isClassDeclaration(s) &&
        s.name?.text === name &&
        ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
    )
  )
    throw new Error(
      `${file} must directly export configured Nest module ${name}.`,
    );
}

export function planIntegrationComposition(
  tree: Tree,
  projects: ReadonlyMap<string, ProjectConfiguration>,
  emitted: readonly { target: string; content: string }[],
  input?: string,
) {
  if (!input) return undefined;
  const options = schema.parse(JSON.parse(input));
  const project = projects.get(options.project);
  if (!project || project.projectType === 'application' || project.root === '.')
    throw new Error(
      '--composition.project must select an existing Nx library; create it with the workspace’s Nx library generator first.',
    );
  const root = safe(project.sourceRoot ?? `${project.root}/src`);
  if (!root.startsWith(`${safe(project.root)}/`))
    throw new Error('Composition sourceRoot must be inside its Nx library.');
  const target = `${root}/playstack-platform.module.ts`;
  const index = `${root}/index.ts`;
  const stateText = tree.read(COMPOSITION_STATE, 'utf8');
  const state = stateSchema.parse(
    stateText ? JSON.parse(stateText) : { schemaVersion: 1, files: {} },
  );
  const read = (file: string) =>
    emitted.find((e) => e.target === file)?.content ?? tree.read(file, 'utf8');
  const seen = new Set<string>();
  const modules = options.modules.map((entry, i) => {
    safe(entry.file);
    if (
      !entry.file.startsWith(`${project.root}/`) ||
      entry.file === target ||
      seen.has(entry.file)
    )
      throw new Error(
        'Composition modules must be unique configured files inside the selected library, not imports back into applications.',
      );
    seen.add(entry.file);
    const content = read(entry.file);
    if (content === null)
      throw new Error(
        `Configured composition module ${entry.file} is missing.`,
      );
    exportedModule(entry.file, content, entry.export);
    const relative = posix
      .relative(root, entry.file)
      .replace(/\.[cm]?tsx?$/, '');
    return {
      ...entry,
      alias: `Integration${i}`,
      specifier: relative.startsWith('.') ? relative : `./${relative}`,
    };
  });
  const content = `// Ejectable Megamono composition root. Configure each imported module in its own file.\nimport { Module } from '@nestjs/common';\n${modules.map((m) => `import { ${m.export} as ${m.alias} } from ${JSON.stringify(m.specifier)};`).join('\n')}\n\n@Module({ imports: [${modules.map((m) => m.alias).join(', ')}], exports: [${modules.map((m) => m.alias).join(', ')}] })\nexport class PlaystackPlatformModule {}\n`;
  const previous = tree.read(target, 'utf8');
  if (
    previous !== null &&
    previous !== content &&
    state.files[target] !== integrationFingerprint(previous)
  )
    throw new Error(
      `Composition root ${target} has unowned or modified content; it must be reviewed rather than overwritten.`,
    );
  const writes: { target: string; content: string }[] = [{ target, content }];
  const indexContent = tree.read(index, 'utf8') ?? '';
  const indexSource = ts.createSourceFile(
    index,
    indexContent,
    ts.ScriptTarget.Latest,
    true,
  );
  const existingExport = indexSource.statements.find(
    (s) =>
      ts.isExportDeclaration(s) &&
      s.moduleSpecifier &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text.replace(/\.js$/, '') ===
        './playstack-platform.module',
  );
  if (existingExport) {
    if (
      !ts.isExportDeclaration(existingExport) ||
      existingExport.isTypeOnly ||
      (existingExport.exportClause &&
        (!ts.isNamedExports(existingExport.exportClause) ||
          !existingExport.exportClause.elements.some(
            (e) =>
              !e.isTypeOnly &&
              e.name.text === 'PlaystackPlatformModule' &&
              (!e.propertyName ||
                e.propertyName.text === 'PlaystackPlatformModule'),
          )))
    )
      throw new Error('The composition barrel has a conflicting export.');
  } else {
    if (/\bPlaystackPlatformModule\b/.test(indexContent))
      throw new Error(
        'The library barrel already owns the PlaystackPlatformModule name.',
      );
    writes.push({
      target: index,
      content: `${indexContent.trimEnd()}\nexport { PlaystackPlatformModule } from './playstack-platform.module';\n`,
    });
  }
  if (options.connect) {
    const connection = options.connect;
    safe(connection.file);
    const application = [...projects.values()].find(
      (p) =>
        p.projectType === 'application' &&
        connection.file.startsWith(`${p.root}/`),
    );
    if (!application)
      throw new Error(
        'Composition connection must select an existing Nx application module file.',
      );
    const manifest = JSON.parse(
      tree.read(`${project.root}/package.json`, 'utf8') ?? '{}',
    );
    const aliases = ['tsconfig.base.json', 'tsconfig.json'].flatMap((p) => {
      const raw = tree.read(p, 'utf8');
      if (!raw) return [];
      const config = ts.parseConfigFileTextToJson(p, raw).config;
      return (config?.compilerOptions?.paths?.[connection.importPath] ??
        []) as string[];
    });
    if (
      manifest.name !== connection.importPath &&
      !aliases.some((p) => p.replace(/^\.\//, '') === index)
    )
      throw new Error(
        'Composition importPath must match the library package name or an existing exact TypeScript index alias.',
      );
    const current = tree.read(connection.file, 'utf8');
    if (current === null)
      throw new Error(`Missing application module ${connection.file}.`);
    const source = ts.createSourceFile(
      connection.file,
      current,
      ts.ScriptTarget.Latest,
      true,
    );
    const metadata = nestModule(source, connection.module);
    if (metadata.properties.some(ts.isSpreadAssignment))
      throw new Error(
        'Dynamic AppModule metadata requires manual composition wiring.',
      );
    const imports = metadata.properties.find(
      (p) => p.name?.getText(source) === 'imports',
    );
    if (
      imports &&
      (!ts.isPropertyAssignment(imports) ||
        !ts.isArrayLiteralExpression(imports.initializer))
    )
      throw new Error('AppModule imports must be a static array.');
    const imported = source.statements
      .filter(ts.isImportDeclaration)
      .find(
        (s) =>
          ts.isStringLiteral(s.moduleSpecifier) &&
          s.moduleSpecifier.text === connection.importPath &&
          s.importClause?.namedBindings &&
          ts.isNamedImports(s.importClause.namedBindings) &&
          s.importClause.namedBindings.elements.some(
            (e) =>
              e.name.text === 'PlaystackPlatformModule' &&
              !e.isTypeOnly &&
              !s.importClause?.isTypeOnly &&
              (e.propertyName ?? e.name).text === 'PlaystackPlatformModule',
          ),
      );
    if (!imported && /\bPlaystackPlatformModule\b/.test(current))
      throw new Error(
        'AppModule already owns the PlaystackPlatformModule identifier.',
      );
    let updated = current;
    if (
      imports &&
      ts.isPropertyAssignment(imports) &&
      ts.isArrayLiteralExpression(imports.initializer)
    ) {
      const array = imports.initializer;
      if (
        !array.elements.some(
          (e) => ts.isIdentifier(e) && e.text === 'PlaystackPlatformModule',
        )
      ) {
        const start = array.getStart(source) + 1;
        updated = `${current.slice(0, start)}PlaystackPlatformModule${array.elements.length ? ', ' : ''}${current.slice(start)}`;
      }
    } else {
      const start = metadata.getStart(source) + 1;
      updated = `${current.slice(0, start)} imports: [PlaystackPlatformModule],${current.slice(start)}`;
    }
    if (!imported)
      updated = `import { PlaystackPlatformModule } from ${JSON.stringify(connection.importPath)};\n${updated}`;
    writes.push({ target: connection.file, content: updated });
  }
  return {
    project: options.project,
    target,
    modules,
    writes,
    state,
    selection: options,
  };
}
