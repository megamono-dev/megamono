import { logger, type PromiseExecutor } from '@nx/devkit';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  isSafeWorkspaceRelativePath,
  readMegamonoConfig,
} from '../../lib/config';
import { formatDiagnostic, hasErrors } from '../../lib/diagnostics';
import {
  collectPreviousDocumentSources,
  validatePublicVisibilityReviews,
  validateRepositoryDocs,
} from '../../lib/docs';
import type { DocsValidateExecutorSchema } from './schema';

async function loadContentCollections(): Promise<
  typeof import('@content-collections/core')
> {
  // Nx executes local plugin source through a CommonJS TypeScript loader. A
  // native import expression keeps the ESM-only Content Collections package
  // loadable in both that development path and the compiled executor.
  const nativeImport = Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<typeof import('@content-collections/core')>;
  return nativeImport('@content-collections/core');
}

async function writeDerivedEntryPoints(outputDirectory: string): Promise<void> {
  const files: Readonly<Record<string, string>> = {
    'repo-docs.js': `import { allRepoDocs } from './index.js';

const repoDocs = allRepoDocs;
export { repoDocs };
export default repoDocs;
`,
    'repo-docs.d.ts': `import type { RepoDoc } from './index.js';

export declare const repoDocs: Array<RepoDoc>;
export default repoDocs;
`,
    'public-repo-docs.js': `import { allRepoDocs } from './index.js';

const publicRepoDocs = allRepoDocs.filter(
  (document) => document.visibility === 'public',
);
export { publicRepoDocs };
export default publicRepoDocs;
`,
    'public-repo-docs.d.ts': `import type { RepoDoc } from './index.js';

export type PublicRepoDoc = RepoDoc & { visibility: 'public' };
export declare const publicRepoDocs: Array<PublicRepoDoc>;
export default publicRepoDocs;
`,
    'package.json': `${JSON.stringify(
      {
        name: 'content-collections',
        private: true,
        type: 'module',
        exports: {
          '.': { types: './index.d.ts', import: './index.js' },
          './repo-docs': {
            types: './repo-docs.d.ts',
            import: './repo-docs.js',
          },
          './public-repo-docs': {
            types: './public-repo-docs.d.ts',
            import: './public-repo-docs.js',
          },
        },
      },
      null,
      2,
    )}\n`,
  };
  await Promise.all(
    Object.entries(files).map(([fileName, content]) =>
      writeFile(resolve(outputDirectory, fileName), content, 'utf8'),
    ),
  );
}

const runExecutor: PromiseExecutor<DocsValidateExecutorSchema> = async (
  options,
  context,
) => {
  try {
    const contentConfig = options.contentConfig ?? 'content-collections.ts';
    const outputDir = options.outputDir ?? '.content-collections';
    if (
      !isSafeWorkspaceRelativePath(contentConfig) ||
      !isSafeWorkspaceRelativePath(outputDir)
    )
      throw new Error(
        'contentConfig and outputDir must be safe workspace-relative paths.',
      );
    const { createBuilder } = await loadContentCollections();
    const outputDirectory = resolve(context.root, outputDir);
    const builder = await createBuilder(
      resolve(context.root, contentConfig),
      {
        configName: 'content-collections',
        outputDir: outputDirectory,
      },
    );
    const collectionErrors: Error[] = [];
    builder.on('_error', ({ error }) => collectionErrors.push(error));
    await builder.build();
    if (collectionErrors.length > 0) {
      throw new AggregateError(
        collectionErrors,
        `Content Collections failed with ${collectionErrors.length} validation error(s):\n${collectionErrors
          .map((error) => error.message)
          .join('\n')}`,
      );
    }
    await writeDerivedEntryPoints(outputDirectory);
    const config = await readMegamonoConfig(
      context.root,
      options.config ?? 'megamono.json',
    );
    const result = await validateRepositoryDocs(
      context.root,
      config,
      options.docsRoot,
    );
    const previousSources = process.env.NX_BASE
      ? await collectPreviousDocumentSources(
          context.root,
          result.documents,
          process.env.NX_BASE,
        )
      : new Map<string, string>();
    const diagnostics = [
      ...result.diagnostics,
      ...validatePublicVisibilityReviews(result.documents, previousSources),
    ];
    for (const diagnostic of diagnostics) {
      const message = formatDiagnostic(diagnostic);
      if (diagnostic.severity === 'error') logger.error(message);
      else logger.warn(message);
    }
    if (hasErrors(diagnostics)) return { success: false };
    if (options.verbose) {
      logger.info(`Validated ${result.documents.length} repository documents.`);
    }
    return { success: true };
  } catch (error) {
    logger.error((error as Error).message);
    return { success: false };
  }
};

export default runExecutor;
