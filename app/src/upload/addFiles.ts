/** The frontier_add_files tool result (view "add_files"), sanitised like the other payloads. */
export interface AddFilesPayload { view: 'add_files'; task_id: string; instruction: string; existing: boolean }

export function parseAddFiles(v: unknown): AddFilesPayload | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.view !== 'add_files' || typeof r.task_id !== 'string' || !r.task_id || r.task_id.length > 200) return null;
  const instruction = typeof r.instruction === 'string' ? r.instruction.slice(0, 600) : '';
  return { view: 'add_files', task_id: r.task_id, instruction, existing: r.existing === true };
}
