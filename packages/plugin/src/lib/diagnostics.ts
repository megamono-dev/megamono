import type { DependencyFindingIdentity } from './dependency-policy-contract';

export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly identity?: DependencyFindingIdentity;
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.path ? `${diagnostic.path}: ` : '';
  return `${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${location}${diagnostic.message}`;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
