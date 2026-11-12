export interface AuditProductionExecutorSchema {
  auditLevel?: 'low' | 'moderate' | 'high' | 'critical';
  registry?: string;
}
