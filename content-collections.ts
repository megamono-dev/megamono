import { defineCollection, defineConfig } from '@content-collections/core';
import { repositoryContentCollectionSchema } from '@megamono/plugin';

const repoDocs = defineCollection({
  name: 'repoDocs',
  directory: 'docs',
  include: [
    'specs/**/*.md',
    'plans/**/*.md',
    'decisions/**/*.md',
    'audits/**/*.md',
    'research/**/*.md',
    'reports/**/*.md',
  ],
  exclude: ['**/README.md', '**/OVERVIEW.md', '**/INDEX.md'],
  schema: repositoryContentCollectionSchema,
});

const archivedDocs = defineCollection({
  name: 'archivedDocs',
  directory: 'docs/archives',
  include: ['**/*.md'],
  exclude: ['**/INDEX.md'],
  schema: repositoryContentCollectionSchema,
});

export default defineConfig({ content: [repoDocs, archivedDocs] });
