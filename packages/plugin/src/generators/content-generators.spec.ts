import {
  readJson,
  readProjectConfiguration,
  writeJson,
  type Tree,
} from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { DEFAULT_MEGAMONO_CONFIG } from '../lib/config';
import contentLibGenerator from './content-lib/content-lib';
import contentTypeGenerator from './content-type/content-type';

function fixture(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'package.json', {
    name: '@acme/source',
    private: true,
    workspaces: ['packages/*'],
  });
  writeJson(tree, 'tsconfig.base.json', {
    compilerOptions: { paths: {} },
  });
  writeJson(tree, 'megamono.json', DEFAULT_MEGAMONO_CONFIG);
  tree.write('.gitignore', 'node_modules/\n');
  tree.write('.prettierignore', 'dist/\n');
  return tree;
}

function changeSnapshot(tree: Tree): readonly string[] {
  return tree
    .listChanges()
    .map(
      (change) =>
        `${change.type}:${change.path}:${change.content?.toString('utf8') ?? ''}`,
    );
}

function readText(tree: Tree, path: string): string {
  const value = tree.read(path, 'utf8');
  if (value === null) throw new Error(`Missing fixture file ${path}.`);
  return value;
}

describe('content collection generators', () => {
  it('creates a buildable content library contract', async () => {
    const tree = fixture();

    await contentLibGenerator(tree, { name: 'Editorial Content' });

    const project = readProjectConfiguration(tree, '@acme/editorial-content');
    expect(project).toMatchObject({
      root: 'packages/editorial-content',
      sourceRoot: 'packages/editorial-content/content',
      projectType: 'library',
      tags: ['scope:shared', 'type:data'],
      targets: {
        build: {
          executor: 'nx:run-commands',
          cache: true,
          inputs: [
            '{projectRoot}/content-collections.ts',
            '{projectRoot}/schemas/**/*.ts',
            '{projectRoot}/content/**/*',
          ],
          outputs: ['{projectRoot}/.content-collections'],
          options: {
            command: 'node build-content.mjs',
            cwd: 'packages/editorial-content',
          },
        },
      },
    });
    expect(
      readJson(tree, 'packages/editorial-content/package.json'),
    ).toMatchObject({
      name: '@acme/editorial-content',
      private: true,
      dependencies: { '@playstack/content': '0.1.0-beta.1' },
      devDependencies: {
        '@content-collections/core': '0.15.2',
        zod: '^4.1.12',
      },
      megamono: {
        contentCollection: {
          version: 1,
          name: 'editorial-content',
          types: [],
        },
      },
    });
    expect(
      tree.read('packages/editorial-content/content-collections.ts', 'utf8'),
    ).toContain("from '@playstack/content'");
    expect(
      tree.read('packages/editorial-content/build-content.mjs', 'utf8'),
    ).toContain('configName: "content-editorial-content"');
    expect(readJson(tree, 'tsconfig.base.json')).toMatchObject({
      compilerOptions: {
        paths: {
          '@acme/editorial-content': [
            './packages/editorial-content/.content-collections/index.js',
          ],
        },
      },
    });
    expect(tree.read('.gitignore', 'utf8')).toContain(
      'packages/editorial-content/.content-collections/',
    );
  });

  it('rebases a root yalc package address into the generated package', async () => {
    const tree = fixture();
    writeJson(tree, 'package.json', {
      name: '@acme/source',
      private: true,
      workspaces: ['packages/*'],
      dependencies: {
        '@playstack/content': 'file:.yalc/@playstack/content',
      },
    });

    await contentLibGenerator(tree, { name: 'articles' });

    expect(readJson(tree, 'packages/articles/package.json')).toMatchObject({
      dependencies: {
        '@playstack/content': 'file:../../.yalc/@playstack/content',
      },
    });
  });

  it('adds deterministic schema-backed types and reruns as a no-op', async () => {
    const tree = fixture();
    await contentLibGenerator(tree, { name: 'articles' });
    await contentTypeGenerator(tree, {
      collection: 'articles',
      name: 'Blog Post',
    });
    await contentTypeGenerator(tree, {
      collection: '@acme/articles',
      name: 'Article',
    });

    const config = readText(tree, 'packages/articles/content-collections.ts');
    expect(config.indexOf('const article =')).toBeLessThan(
      config.indexOf('const blogPost ='),
    );
    expect(config).toContain('directory: "content/blog-post"');
    expect(config).toContain('playstackContentTransforms.normalizeDate');
    expect(config).toContain('playstackContentTransforms.readingTime');
    expect(config).toContain('playstackContentTransforms.extractToc');
    expect(config).toContain('playstackContentTransforms.slugify');
    expect(tree.read('packages/articles/schemas/blog-post.ts', 'utf8')).toBe(
      `import { contentBase } from '@playstack/content/schema';
import { z } from 'zod';

export const blogPostSchema = z.object({
  ...contentBase,
  content: z.string(),
});
`,
    );
    expect(tree.exists('packages/articles/content/blog-post/.gitkeep')).toBe(
      true,
    );
    expect(readJson(tree, 'packages/articles/package.json')).toMatchObject({
      megamono: {
        contentCollection: {
          types: ['article', 'blog-post'],
        },
      },
    });

    const before = changeSnapshot(tree);
    await contentLibGenerator(tree, { name: 'articles' });
    await contentTypeGenerator(tree, {
      collection: 'articles',
      name: 'blog-post',
    });
    expect(changeSnapshot(tree)).toEqual(before);
  });

  it('refuses project, path-alias, type, and generated-config collisions', async () => {
    const occupied = fixture();
    occupied.write('packages/articles/README.md', 'owned\n');
    await expect(
      contentLibGenerator(occupied, { name: 'articles' }),
    ).rejects.toThrow(/already exists/);
    expect(occupied.exists('packages/articles/project.json')).toBe(false);

    const aliased = fixture();
    writeJson(aliased, 'tsconfig.base.json', {
      compilerOptions: {
        paths: { '@acme/articles': ['./packages/other/src/index.ts'] },
      },
    });
    await expect(
      contentLibGenerator(aliased, { name: 'articles' }),
    ).rejects.toThrow(/already defines @acme\/articles/);
    expect(aliased.exists('packages/articles/project.json')).toBe(false);

    const typeCollision = fixture();
    await contentLibGenerator(typeCollision, { name: 'articles' });
    typeCollision.write(
      'packages/articles/schemas/post.ts',
      'export const owned = true;\n',
    );
    await expect(
      contentTypeGenerator(typeCollision, {
        collection: 'articles',
        name: 'post',
      }),
    ).rejects.toThrow(/already exists/);
    expect(treeTypes(typeCollision, 'packages/articles/package.json')).toEqual(
      [],
    );

    const changedConfig = fixture();
    await contentLibGenerator(changedConfig, { name: 'articles' });
    changedConfig.write(
      'packages/articles/content-collections.ts',
      '// repository-owned changes\n',
    );
    await expect(
      contentTypeGenerator(changedConfig, {
        collection: 'articles',
        name: 'post',
      }),
    ).rejects.toThrow(/differs from its Megamono marker/);
    expect(changedConfig.exists('packages/articles/schemas/post.ts')).toBe(
      false,
    );
  });

  it('requires an initialized workspace and an existing content collection', async () => {
    const uninitialized = fixture();
    uninitialized.delete('megamono.json');
    await expect(
      contentLibGenerator(uninitialized, { name: 'articles' }),
    ).rejects.toThrow(/Run workspace-init first/);

    const missing = fixture();
    await expect(
      contentTypeGenerator(missing, {
        collection: 'articles',
        name: 'post',
      }),
    ).rejects.toThrow(/Run content-lib first/);
  });
});

function treeTypes(tree: Tree, path: string): readonly string[] {
  return (
    readJson(tree, path) as {
      readonly megamono: {
        readonly contentCollection: { readonly types: readonly string[] };
      };
    }
  ).megamono.contentCollection.types;
}
