import type { TaskPayload } from './types';

/** Fold a newer payload into the previous one. The view endpoint omits `view`, so keep the old one. */
export function merge(prev: TaskPayload | null, next: TaskPayload): TaskPayload {
  if (!prev) return next;
  return {
    ...next,
    view: next.view ?? prev.view,
    cursor: Math.max(prev.cursor, next.cursor),
  };
}
