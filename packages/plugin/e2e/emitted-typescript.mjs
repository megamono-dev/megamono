import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

// Explicit files, including tests, avoid the common production-tsconfig exclude
// that can make a broken generated test invisible to consumer qualification.
export function checkEmittedTypeScript(root, files) {
  const require = createRequire(join(root, 'package.json'));
  const ts = require('typescript');
  const program = ts.createProgram(
    files.map((file) => resolve(root, file)),
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      types: ['node', 'jest'],
    },
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return {
    passed: diagnostics.length === 0,
    files,
    diagnostics: diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      file: diagnostic.file?.fileName,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    })),
  };
}
