export interface RunExecutorSchema {
  tool: 'cargo' | 'tauri';
  args: string[];
  cwd?: string;
}
