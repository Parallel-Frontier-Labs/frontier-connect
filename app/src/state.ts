import type { TaskEvent, TaskPayload } from './types';

/** How many recent events the card keeps across polls (each poll returns only the new ones). */
export const KEEP_EVENTS = 60;

/** Events of both pages, oldest first, one per seq, the newest KEEP_EVENTS. */
function joinEvents(a: TaskEvent[], b: TaskEvent[]): TaskEvent[] {
  const bySeq = new Map<number, TaskEvent>();
  for (const e of a) bySeq.set(e.seq, e);
  for (const e of b) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq).slice(-KEEP_EVENTS);
}

/** Fold a newer payload into the previous one. The view endpoint omits `view`, so keep the old one.
 *  Events are paged by cursor, so they accumulate (latest activity, the end reason). */
export function merge(prev: TaskPayload | null, next: TaskPayload): TaskPayload {
  if (!prev) return next;
  return {
    ...next,
    view: next.view ?? prev.view,
    // A result that does not say (an answer result, an older server) keeps what the card knew.
    browser: next.browser !== undefined ? next.browser : prev.browser,
    cursor: Math.max(prev.cursor, next.cursor),
    events: joinEvents(prev.events, next.events),
  };
}
