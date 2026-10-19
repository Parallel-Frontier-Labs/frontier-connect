import { describe, expect, it } from 'vitest';
import { KEEP_EVENTS, merge } from '../src/state';
import type { TaskPayload } from '../src/types';

const base: TaskPayload = { task_id: 't', status: 'running', title: 'T', plan: [], sections: [], live: null, estimate: null,
  open_ask: null, deliverables: [], result: null, work_ms: 0, usage: null, events: [], cursor: 3, more: false,
  view: { token: 'tok', expires_in_s: 1800, url: 'https://api.example.com/v1/runs/t/view' } };

describe('merge', () => {
  it('keeps the view token when the view endpoint omits it, and the larger cursor', () => {
    const next = { ...base, view: undefined, cursor: 2, status: 'done' as const };
    const out = merge(base, next);
    expect(out.view?.token).toBe('tok');
    expect(out.cursor).toBe(3);
    expect(out.status).toBe('done');
  });
  it('takes a new view when provided, and returns next when there is no prev', () => {
    const v = { token: 'new', expires_in_s: 10, url: 'u' };
    expect(merge(base, { ...base, view: v }).view?.token).toBe('new');
    expect(merge(null, base)).toBe(base);
  });

  it('accumulates paged events by seq, oldest first, capped', () => {
    const ev = (seq: number) => ({ seq, kind: 'narration', text: `e${seq}` });
    const a = merge({ ...base, events: [ev(1), ev(2)] }, { ...base, events: [ev(2), ev(3)] });
    expect(a.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    const many = merge({ ...base, events: Array.from({ length: 50 }, (_, i) => ev(i)) }, { ...base, events: Array.from({ length: 50 }, (_, i) => ev(i + 50)) });
    expect(many.events.length).toBe(KEEP_EVENTS);
    expect(many.events.at(-1)!.seq).toBe(99);
  });
});
