import type { ProjectGraph } from '@nx/devkit';
import {
  checkProjectPreflights,
  PROJECT_PREFLIGHT_METADATA_KEY,
} from './project-preflight';

function graph(): ProjectGraph {
  return {
    nodes: {
      AppleApp: {
        name: 'AppleApp',
        type: 'app',
        data: {
          root: 'apps/apple',
          metadata: {
            [PROJECT_PREFLIGHT_METADATA_KEY]: {
              diagnostics: [
                {
                  severity: 'error',
                  code: 'apple-scheme',
                  message: 'Configure a shared scheme.',
                  path: 'apps/apple/App.xcodeproj/project.pbxproj',
                },
              ],
              requiredTools: [
                { executable: 'swiftlint', reason: 'lint target' },
                { executable: 'xcodebuild', reason: 'Xcode targets' },
              ],
            },
          },
        },
      },
    },
    dependencies: { AppleApp: [] },
  };
}

describe('project preflight checks', () => {
  it('surfaces plugin diagnostics and missing executables', async () => {
    const checked: string[] = [];
    const diagnostics = await checkProjectPreflights(
      graph(),
      async (executable) => {
        checked.push(executable);
        return executable === 'xcodebuild';
      },
    );
    expect(checked).toEqual(['swiftlint', 'xcodebuild']);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'apple-scheme',
        message: 'Configure a shared scheme.',
        path: 'apps/apple/App.xcodeproj/project.pbxproj',
      },
      {
        severity: 'error',
        code: 'missing-toolchain',
        path: 'apps/apple',
        message: 'AppleApp requires swiftlint: lint target',
      },
    ]);
  });

  it('checks a shared executable only once', async () => {
    const projectGraph = graph();
    projectGraph.nodes.SecondApp = {
      name: 'SecondApp',
      type: 'app',
      data: {
        root: 'apps/second',
        metadata: {
          [PROJECT_PREFLIGHT_METADATA_KEY]: {
            requiredTools: [
              { executable: 'xcodebuild', reason: 'Xcode targets' },
            ],
          },
        },
      },
    };
    projectGraph.dependencies.SecondApp = [];
    const checked: string[] = [];
    await checkProjectPreflights(projectGraph, async (executable) => {
      checked.push(executable);
      return true;
    });
    expect(checked.filter((value) => value === 'xcodebuild')).toHaveLength(1);
  });
});
