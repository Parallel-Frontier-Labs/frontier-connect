import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { parseList } from '../src/list';
import { FullView } from '../src/view/FullView';

afterEach(cleanup);

const row = (id: string) => ({ task_id: id, title: `Task ${id}`, status: 'done', started_at: '2026-10-25T17:47:00Z', source: 'claude', work_ms: 1000, turn: 1 });
const list = parseList({ view: 'list', items: ['a', 'b', 'c'].map(row), total: 3, shown: 3, next_cursor: null, capped: false,
  filters: { days: 7, status: null, source: null, query: null } })!;
const acts = { enabled: true, query: async () => null, open: async () => null, remove: async () => ({ kind: 'deleted' }) } as never;

/** matchMedia whose answer is read live from `state`; `listeners` get the change events. */
function media(state: { narrow: boolean }) {
  const listeners: (() => void)[] = [];
  window.matchMedia = ((q: string) => ({
    get matches() { return state.narrow; }, media: q,
    addEventListener: (_: string, f: () => void) => listeners.push(f), removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return listeners;
}

function View(p: { selected: string | null; onSelect?: (id: string | null) => void }) {
  return <FullView list={list} actions={acts} selected={p.selected} onSelect={p.onSelect ?? (() => {})} paneNote={null}
    live={false} onExit={() => {}} pane={<div class="pane-body">pane</div>} />;
}

describe('the stacked full view (review 2026-11-07)', () => {
  it('a host that widens the frame before the listener attaches still gets both panes', () => {
    // The first read (the first render) says narrow; the frame has widened by the time effects run,
    // and no change event comes, as when the host resizes between render and the listener attaching.
    let reads = 0;
    window.matchMedia = ((q: string) => ({
      get matches() { reads += 1; return reads === 1; }, media: q,
      addEventListener: () => {}, removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    const { container } = render(<View selected="a" />);
    expect(container.querySelector('.fc-full-stack')).toBeNull();
    expect(container.querySelector('.fc-full-list')).not.toBeNull();
    expect(container.querySelector('.fc-full-pane')).not.toBeNull();
  });

  it('All tasks brings back the list where it was, with focus on the task that was open', async () => {
    media({ narrow: true });
    let sel: string | null = null;
    const { container, rerender } = render(<View selected={sel} onSelect={(id) => { sel = id; }} />);
    const nav = container.querySelector('.fc-full-list') as HTMLElement;
    nav.scrollTop = 140;
    fireEvent.click(container.querySelector('.fc-frow[data-task="b"] .fc-frow-open')!);
    rerender(<View selected={sel} onSelect={(id) => { sel = id; }} />);
    expect(container.querySelector('.fc-full-list')).toBeNull();
    await act(async () => { fireEvent.click(container.querySelector('.fc-back')!); });
    const back = container.querySelector('.fc-full-list') as HTMLElement;
    expect(back.scrollTop).toBe(140);
    expect(document.activeElement).toBe(container.querySelector('.fc-frow[data-task="b"] .fc-frow-open'));
  });
});
