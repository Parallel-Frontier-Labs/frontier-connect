import type { Status } from './types';

/** "Your Frontier tasks": the frontier_list_tasks payload (view "list"), sanitised like a task payload. */
export const LIST_STATUSES = ['running', 'waiting', 'done', 'stopped', 'error'] as const;
export type ListStatus = (typeof LIST_STATUSES)[number];
export const SOURCES = ['frontier', 'claude', 'chatgpt', 'codex', 'scheduled', 'other'] as const;
export type Source = (typeof SOURCES)[number];
export const DAYS = [1, 7, 30, 90] as const;

export interface ListItem {
  task_id: string; title: string; status: ListStatus; started_at: string; source: Source; work_ms: number; turn: number;
}
export interface ListFilters { days: number; status: ListStatus | null; source: Source | null }
export interface ListPayload {
  view: 'list'; items: ListItem[]; total: number; shown: number; next_cursor: string | null;
  filters: ListFilters; capped: boolean; org: string | null;
}

/** The cap the server applies per query (it stops issuing cursors there). */
export const LIST_CAP = 50;

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const int = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
const oneOf = <T extends string>(all: readonly T[], v: unknown): T | null => all.find((x) => x === v) ?? null;

/** Validate and sanitise an untrusted list payload; null when it is not one. */
export function parseList(v: unknown): ListPayload | null {
  const r = obj(v);
  if (!r || r.view !== 'list' || !Array.isArray(r.items)) return null;
  const f = obj(r.filters) ?? {};
  const days = int(f.days, 7);
  const items: ListItem[] = [];
  for (const raw of r.items.slice(0, 200)) {
    const i = obj(raw);
    if (!i || typeof i.task_id !== 'string' || !i.task_id || i.task_id.length > 200) continue;
    const started = typeof i.started_at === 'string' && !Number.isNaN(Date.parse(i.started_at)) ? i.started_at.slice(0, 40) : '';
    items.push({
      task_id: i.task_id,
      title: (typeof i.title === 'string' && i.title.trim() ? i.title : 'Untitled task').slice(0, 200),
      status: oneOf(LIST_STATUSES, i.status) ?? 'done',
      started_at: started,
      source: oneOf(SOURCES, i.source) ?? 'other',
      work_ms: int(i.work_ms),
      turn: Math.max(1, Math.min(int(i.turn, 1), 10_000)),
    });
  }
  return {
    view: 'list',
    items,
    total: int(r.total, items.length),
    shown: int(r.shown, items.length),
    next_cursor: typeof r.next_cursor === 'string' && r.next_cursor && r.next_cursor.length <= 2000 ? r.next_cursor : null,
    filters: {
      // Any whole number of days the server accepts (1 to 90) is kept as is; the presets are only the chips' shortcuts.
      days: days >= 1 ? Math.min(days, 90) : 7,
      status: oneOf(LIST_STATUSES, f.status),
      source: oneOf(SOURCES, f.source === 'desktop' ? 'frontier' : f.source),
    },
    capped: r.capped === true,
    org: typeof r.org === 'string' && r.org ? r.org.slice(0, 80) : null,
  };
}

/** A further page: its rows appended (one per task id), counts and cursor from the new page. */
export function appendPage(prev: ListPayload, next: ListPayload): ListPayload {
  const seen = new Set(prev.items.map((i) => i.task_id));
  return { ...next, org: next.org ?? prev.org, items: [...prev.items, ...next.items.filter((i) => !seen.has(i.task_id))] };
}

/** A list row's status as the task card names it. */
export const LIST_STATUS_LABEL: Record<ListStatus, string> = {
  running: 'Working', waiting: 'Needs your answer', done: 'Done', stopped: 'Stopped', error: 'Failed',
};
export const LIST_STATUS_FOR_PILL: Record<ListStatus, Status> = {
  running: 'running', waiting: 'waiting_for_answer', done: 'done', stopped: 'stopped', error: 'error',
};
export const SOURCE_LABEL: Record<Source, string> = {
  frontier: 'Frontier', claude: 'Claude', chatgpt: 'ChatGPT', codex: 'Codex', scheduled: 'Scheduled', other: 'Another AI app',
};
/** Running or waiting: the server refuses to delete these ("Stop the task first."). */
export const isLive = (s: ListStatus): boolean => s === 'running' || s === 'waiting';
