import {
  addProjectConfiguration,
  readProjectConfiguration,
  type Tree,
} from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { emailsAdoptGenerator, type EmailsAdoptSchema } from './emails-adopt';

const options: EmailsAdoptSchema = {
  project: 'emails',
  previewTarget: 'preview',
  verificationTarget: 'test',
  templatesRoot: 'libs/emails/templates',
  fixturesRoot: 'libs/emails/fixtures',
  themeFile: 'libs/theme/tokens.ts',
  reviewedLocalOnly: true,
  reviewedFixtureOnly: true,
};
function fixture(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  addProjectConfiguration(tree, 'emails', {
    root: 'libs/emails',
    projectType: 'library',
    targets: {
      preview: {
        executor: 'nx:run-commands',
        cache: false,
        options: { command: 'node preview.mjs' },
      },
      test: {
        executor: 'nx:run-commands',
        cache: false,
        options: { command: 'node --test' },
      },
    },
  });
  tree.write('libs/emails/templates/welcome.tsx', '// application template');
  tree.write('libs/emails/fixtures/welcome.json', '{"name":"Fixture"}');
  tree.write(options.themeFile, '// shared custom theme');
  return tree;
}
describe('email preview adoption', () => {
  it('plans by default and never runs application commands', async () => {
    const tree = fixture();
    const before = tree.listChanges();
    await emailsAdoptGenerator(tree, options);
    expect(tree.listChanges()).toEqual(before);
    await emailsAdoptGenerator(tree, { ...options, yes: true, planOnly: true });
    expect(tree.listChanges()).toEqual(before);
  });
  it('preserves templates, theme, package manifest and preview target, with no-op reruns', async () => {
    const tree = fixture();
    const manifest = tree.read('package.json', 'utf8');
    const preview = readProjectConfiguration(tree, 'emails').targets?.preview;
    await emailsAdoptGenerator(tree, { ...options, yes: true });
    expect(tree.read('package.json', 'utf8')).toBe(manifest);
    expect(readProjectConfiguration(tree, 'emails').targets?.preview).toEqual(
      preview,
    );
    expect(
      readProjectConfiguration(tree, 'emails').targets?.[
        'megamono-emails-verify'
      ].dependsOn,
    ).toEqual(['test']);
    const first = tree.listChanges();
    await emailsAdoptGenerator(tree, { ...options, yes: true });
    expect(tree.listChanges()).toEqual(first);
    tree.write(options.themeFile, '// edited custom theme');
    await emailsAdoptGenerator(tree, { ...options, yes: true });
    expect(tree.read(options.themeFile, 'utf8')).toBe('// edited custom theme');
    expect(
      JSON.parse(
        tree.read('.megamono/email-previews/emails.json', 'utf8') ?? '{}',
      ).qualification,
    ).toBe('not-run');
  });
  it.each([
    { reviewedLocalOnly: false },
    { reviewedFixtureOnly: false },
    { previewTarget: 'missing' },
    { verificationTarget: 'preview' },
    { fixturesRoot: '../outside' },
    { themeFile: '/outside' },
    { templatesRoot: 'libs/missing' },
    { verificationTarget: 'megamono-emails-verify' },
  ])(
    'rejects incomplete or unsafe mappings before writes: %j',
    async (invalid) => {
      const tree = fixture();
      const before = tree.listChanges();
      await expect(
        emailsAdoptGenerator(tree, { ...options, ...invalid, yes: true }),
      ).rejects.toThrow();
      expect(tree.listChanges()).toEqual(before);
    },
  );
  it('rejects cacheable preview and conflicting targets without mutation', async () => {
    const tree = fixture();
    const file = 'libs/emails/project.json';
    const project = JSON.parse(tree.read(file, 'utf8') ?? '{}');
    project.targets.preview.cache = true;
    tree.write(file, JSON.stringify(project));
    await expect(
      emailsAdoptGenerator(tree, { ...options, yes: true }),
    ).rejects.toThrow('disable caching');
    project.targets.preview.cache = false;
    project.targets['megamono-emails-verify'] = { command: 'custom test' };
    tree.write(file, JSON.stringify(project));
    const before = tree.listChanges();
    await expect(
      emailsAdoptGenerator(tree, { ...options, yes: true }),
    ).rejects.toThrow('differs');
    expect(tree.listChanges()).toEqual(before);
  });
  it('rejects continuous verification and changed ownership mappings', async () => {
    const tree = fixture();
    const file = 'libs/emails/project.json';
    const project = JSON.parse(tree.read(file, 'utf8') ?? '{}');
    project.targets.test.continuous = true;
    tree.write(file, JSON.stringify(project));
    await expect(
      emailsAdoptGenerator(tree, { ...options, yes: true }),
    ).rejects.toThrow('not continuous');
    project.targets.test.continuous = false;
    tree.write(file, JSON.stringify(project));
    await emailsAdoptGenerator(tree, { ...options, yes: true });
    tree.write('libs/theme/other.ts', '// other theme');
    const before = tree.listChanges();
    await expect(
      emailsAdoptGenerator(tree, {
        ...options,
        themeFile: 'libs/theme/other.ts',
        yes: true,
      }),
    ).rejects.toThrow('mapping differs');
    expect(tree.listChanges()).toEqual(before);
  });
});
