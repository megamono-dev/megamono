import { addProjectConfiguration, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { detectWebStyling, isWebStyling } from './web-styling';

describe('web styling preferences', () => {
  it('recognizes the supported scaffold values', () => {
    expect(isWebStyling('stylex')).toBe(true);
    expect(isWebStyling('shadcn')).toBe(false);
  });

  it('detects an existing app package without making it a convention', () => {
    const tree = createTreeWithEmptyWorkspace();
    addProjectConfiguration(tree, 'site', {
      root: 'apps/site',
      projectType: 'application',
    });
    writeJson(tree, 'apps/site/package.json', {
      dependencies: {
        '@chakra-ui/react': '3.36.1',
        '@emotion/react': '11.14.0',
      },
    });

    expect(detectWebStyling(tree)).toBe('chakra');
  });

  it('maps higher-level systems to their underlying styling tool', () => {
    const tailwind = createTreeWithEmptyWorkspace();
    writeJson(tailwind, 'package.json', {
      dependencies: { tailwindcss: '4.3.3', shadcn: '3.0.0' },
    });
    expect(detectWebStyling(tailwind)).toBe('tailwind');

    const panda = createTreeWithEmptyWorkspace();
    writeJson(panda, 'package.json', {
      devDependencies: { '@pandacss/dev': '1.12.0' },
    });
    expect(detectWebStyling(panda)).toBe('panda');
  });

  it('returns auto when no supported tool is discoverable', () => {
    expect(detectWebStyling(createTreeWithEmptyWorkspace())).toBe('auto');
  });
});
