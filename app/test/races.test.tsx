import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bridge, DeleteOutcome, ListOutcome, ListQuery } from '../src/bridge';
import { parseList, type ListPayload } from '../src/list';
import { Root } from '../src/Root';
import type { TaskPayload } from '../src/types';
import { TaskList, type ListActions } from '../src/view/TaskList';

afterEach(cleanup);
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const row = (n: number, o: Record<string, unknown> = {}) => ({
  task_id: `t${n}`, title: `Task ${n}`, status: 'done', started_at: '2026-10-18T09:42:00Z', source: 'claude', work_ms: 1000, turn: 1, ...o,
});
const listOf = (ids: number[], o: Record<string, unknown> = {}) =>
  parseList({
    view: 'list', items: ids.map((n) => row(n)), total: 30, shown: ids.length, next_cursor: 'c1',
    filters: { days: 7, status: null, source: null }, capped: false, ...o,
  })!;
const task = (id: string) =>
  ({ task_id: id, status: 'done', title: `Detail of ${id}`, plan: [], sections: [], live: null, estimate: null, open_ask: null,
    deliverables: [], result: null, work_ms: 0, usage: null, events: [], cursor: 1, more: false, view: null }) as unknown as TaskPayload;

/** A host bridge whose calls resolve only when the test says so. */
function rig() {
  let onList: (l: ListPayload) => void = () => {};
  let onReady: () => void = () => {};
  const gets: Record<string, ReturnType<typeof deferred<TaskPayload | null>>> = {};
  const lists: { q: ListQuery; d: ReturnType<typeof deferred<ListOutcome>> }[] = [];
  const deletes: Record<string, ReturnType<typeof deferred<DeleteOutcome>>> = {};
  const bridge = {
    onPayload: () => {},
    getTask: vi.fn((id: string) => (gets[id] = deferred<TaskPayload | null>()).promise),
    theme: () => 'light' as const,
    onThemeChange: () => {},
    onConnectError: () => {},
    canCallTools: () => true,
    onReady: (cb: () => void) => (onReady = cb),
    answer: async () => ({ kind: 'failed' as const, message: '' }),
    onList: (cb: (l: ListPayload) => void) => (onList = cb),
    listTasks: vi.fn((q: ListQuery) => {
      const d = deferred<ListOutcome>();
      lists.push({ q, d });
      return d.promise;
    }),
    deleteTask: vi.fn((id: string) => (deletes[id] = deferred<DeleteOutcome>()).promise),
  } as unknown as Bridge;
  return { bridge, gets, lists, deletes, list: (l: ListPayload) => onList(l), ready: () => onReady() };
}

function start(r: ReturnType<typeof rig>, l: ListPayload) {
  render(<Root makeBridge={() => r.bridge} />);
  act(() => r.list(l));
  act(() => r.ready());
}

describe('superseded navigation', () => {
  it("opening A then B: A's late answer never replaces B", async () => {
    const r = rig();
    start(r, listOf([1, 2]));
    fireEvent.click(screen.getByRole('button', { name: 'Task 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Task 2' }));
    await act(async () => { r.gets.t2!.resolve(task('t2')); await tick(); });
    screen.getByText('Detail of t2');
    await act(async () => { r.gets.t1!.resolve(task('t1')); await tick(); });
    screen.getByText('Detail of t2');
    expect(screen.queryByText('Detail of t1')).toBeNull();
  });

  it('a task opened and then superseded by a new list result stays on the list', async () => {
    const r = rig();
    start(r, listOf([1, 2]));
    fireEvent.click(screen.getByRole('button', { name: 'Task 1' }));
    act(() => r.list(listOf([5], { total: 1, next_cursor: null })));
    await act(async () => { r.gets.t1!.resolve(task('t1')); await tick(); });
    screen.getByText('Your Frontier tasks');
    screen.getByText('Task 5');
    expect(screen.queryByText('Detail of t1')).toBeNull();
  });
});

describe('stale pages', () => {
  it('a Show more answer from before a filter change is dropped', async () => {
    const r = rig();
    start(r, listOf([1, 2]));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    // The model (or another card action) loads a new list with other filters meanwhile.
    act(() => r.list(listOf([7], { filters: { days: 30, status: 'done', source: null }, total: 1, next_cursor: null })));
    await act(async () => { r.lists[0]!.d.resolve({ kind: 'ok', list: listOf([3, 4], { shown: 4 }) }); await tick(); });
    screen.getByText('Task 7');
    expect(screen.queryByText('Task 3')).toBeNull();
    expect(screen.queryByText('Task 1')).toBeNull();
  });

  it('a filter answer that arrives after a newer one is dropped', async () => {
    const r = rig();
    start(r, listOf([1, 2]));
    const status = screen.getByLabelText('Status') as HTMLSelectElement;
    fireEvent.change(status, { target: { value: '3' } }); // Done
    // The first query is in flight; a list result arrives and the user filters again.
    act(() => r.list(listOf([1, 2])));
    fireEvent.change(screen.getByLabelText('App') as HTMLSelectElement, { target: { value: '2' } }); // Claude
    await act(async () => { r.lists[1]!.d.resolve({ kind: 'ok', list: listOf([9], { filters: { days: 7, status: null, source: 'claude' } }) }); await tick(); });
    await act(async () => { r.lists[0]!.d.resolve({ kind: 'ok', list: listOf([8], { filters: { days: 7, status: 'done', source: null } }) }); await tick(); });
    screen.getByText('Task 9');
    expect(screen.queryByText('Task 8')).toBeNull();
  });
});

describe('concurrent deletes', () => {
  const del = (title: string) => {
    fireEvent.click(screen.getByRole('button', { name: `More actions for ${title}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  };

  it('two quick deletes both remove their rows and both lower the counts', async () => {
    const r = rig();
    start(r, listOf([1, 2, 3], { total: 3, next_cursor: null }));
    del('Task 1');
    del('Task 2');
    // Both answers land before the card re-renders.
    await act(async () => {
      r.deletes.t2!.resolve({ kind: 'deleted' });
      r.deletes.t1!.resolve({ kind: 'deleted' });
      await tick();
    });
    expect(screen.queryByText('Task 1')).toBeNull();
    expect(screen.queryByText('Task 2')).toBeNull();
    screen.getByText('Task 3');
    screen.getByText('1 of 1');
  });

  it('a delete that resolves after a refresh does not bring back the old rows', async () => {
    const r = rig();
    start(r, listOf([1, 2], { total: 2, next_cursor: null }));
    del('Task 1');
    await act(async () => {
      r.list(listOf([1, 6], { total: 2, next_cursor: null }));
      r.deletes.t1!.resolve({ kind: 'deleted' });
      await tick();
    });
    screen.getByText('Task 6');
    expect(screen.queryByText('Task 2')).toBeNull();
    expect(screen.queryByText('Task 1')).toBeNull();
    screen.getByText('1 of 1');
  });
});

describe('after deleting', () => {
  it('Show more stays and the cursor still loads the next page', async () => {
    const r = rig();
    start(r, listOf([1, 2], { total: 12, next_cursor: 'c1' }));
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Task 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await act(async () => { r.deletes.t1!.resolve({ kind: 'deleted' }); await tick(); });
    screen.getByText('1 of 11');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(r.lists.at(-1)!.q).toEqual({ days: 7, status: null, source: null, cursor: 'c1' });
    await act(async () => { r.lists.at(-1)!.d.resolve({ kind: 'ok', list: listOf([3, 4], { total: 11, shown: 3, next_cursor: null }) }); await tick(); });
    screen.getByText('Task 4');
    screen.getByText('3 of 11');
  });

  it('when the visible rows are all deleted the next page loads by itself', async () => {
    const r = rig();
    start(r, listOf([1], { total: 5, next_cursor: 'c1' }));
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Task 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await act(async () => { r.deletes.t1!.resolve({ kind: 'deleted' }); await tick(); });
    await flush();
    expect(r.lists.at(-1)!.q).toEqual({ days: 7, status: null, source: null, cursor: 'c1' });
    await act(async () => { r.lists.at(-1)!.d.resolve({ kind: 'ok', list: listOf([2, 3], { total: 4, shown: 2, next_cursor: null }) }); await tick(); });
    screen.getByText('Task 2');
  });

  it('at the cap the line counts what is shown after a delete', () => {
    const items = Array.from({ length: 49 }, (_, i) => i);
    const l = listOf(items, { total: 72, shown: 49, capped: true, next_cursor: null });
    const actions: ListActions = { enabled: true, query: async () => null, open: async () => null, remove: async () => ({ kind: 'deleted' }) };
    render(<TaskList list={l} actions={actions} />);
    screen.getByText('Showing 49 of 72. Narrow the dates or filters to see more.');
  });
});

describe('non-preset date ranges', () => {
  it('a model-chosen range like 14 days shows as itself in the summary and the chip', () => {
    const l = listOf([1], { filters: { days: 14, status: null, source: null } });
    const actions: ListActions = { enabled: true, query: vi.fn(async () => null), open: async () => null, remove: async () => ({ kind: 'deleted' }) };
    render(<TaskList list={l} actions={actions} />);
    expect(document.querySelector('.fc-org')!.textContent).toBe('Last 14 days');
    const sel = screen.getByLabelText('Dates') as HTMLSelectElement;
    expect(sel.options[sel.selectedIndex]!.text).toBe('Last 14 days');
    expect(Array.from(sel.options).map((o) => o.text)).toEqual(['Last 24 hours', 'Last 7 days', 'Last 14 days', 'Last 30 days', 'Last 90 days']);
  });

  it('parseList keeps a valid non-preset range and clamps only out-of-range values', () => {
    expect(listOf([1], { filters: { days: 14 } }).filters.days).toBe(14);
    expect(listOf([1], { filters: { days: 0 } }).filters.days).toBe(7);
    expect(listOf([1], { filters: { days: 500 } }).filters.days).toBe(90);
  });
});

describe('every server call is guarded (re-review)', () => {
  const del = (title: string) => {
    fireEvent.click(screen.getByRole('button', { name: `More actions for ${title}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  };
  const asking = (id: string) =>
    ({ ...task(id), status: 'waiting_for_answer',
      open_ask: { ask_id: 'ask_1', kind: 'question', questions: [{ id: 'q', kind: 'confirm', prompt: 'Go ahead?' }] } }) as unknown as TaskPayload;

  it('an answer that comes back after the user moved to another task never brings the old task back', async () => {
    const r = rig();
    const answer = deferred<import('../src/bridge').AnswerOutcome>();
    (r.bridge as unknown as { answer: unknown }).answer = vi.fn(() => answer.promise);
    start(r, listOf([1, 2]));
    fireEvent.click(screen.getByRole('button', { name: 'Task 1' }));
    await act(async () => { r.gets.t1!.resolve(asking('t1')); await tick(); });
    fireEvent.click(screen.getByLabelText('Yes'));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'All tasks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Task 2' }));
    await act(async () => { r.gets.t2!.resolve(task('t2')); await tick(); });
    screen.getByText('Detail of t2');
    await act(async () => { answer.resolve({ kind: 'accepted', payload: { ...task('t1'), status: 'running' } as TaskPayload }); await tick(); });
    screen.getByText('Detail of t2');
    expect(screen.queryByText('Detail of t1')).toBeNull();
  });

  it('a refresh that was in flight when a task was deleted does not bring the row back', async () => {
    const r = rig();
    start(r, listOf([1, 2], { total: 2, next_cursor: null }));
    fireEvent.change(screen.getByLabelText('Status') as HTMLSelectElement, { target: { value: '3' } });
    // The list is still on screen while the filter answer is pending; the row is deleted meanwhile.
    act(() => r.list(listOf([1, 2], { total: 2, next_cursor: null })));
    del('Task 1');
    await act(async () => { r.deletes.t1!.resolve({ kind: 'deleted' }); await tick(); });
    act(() => r.list(listOf([1, 2], { total: 2, next_cursor: null })));
    expect(screen.queryByText('Task 1')).toBeNull();
    screen.getByText('1 of 1');
  });

  it('a page from Show more that still carries a deleted task leaves it out', async () => {
    const r = rig();
    start(r, listOf([1, 2], { total: 4, next_cursor: 'c1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    del('Task 2');
    await act(async () => { r.deletes.t2!.resolve({ kind: 'deleted' }); await tick(); });
    await act(async () => { r.lists[0]!.d.resolve({ kind: 'ok', list: listOf([2, 3], { total: 4, shown: 4, next_cursor: null }) }); await tick(); });
    expect(screen.queryByText('Task 2')).toBeNull();
    screen.getByText('Task 3');
  });

  it('a delete that lands after the user opened another task is still remembered', async () => {
    const r = rig();
    start(r, listOf([1, 2], { total: 2, next_cursor: null }));
    del('Task 1');
    fireEvent.click(screen.getByRole('button', { name: 'Task 2' }));
    await act(async () => { r.gets.t2!.resolve(task('t2')); await tick(); });
    await act(async () => { r.deletes.t1!.resolve({ kind: 'deleted' }); await tick(); });
    screen.getByText('Detail of t2');
    fireEvent.click(screen.getByRole('button', { name: 'All tasks' }));
    expect(screen.queryByText('Task 1')).toBeNull();
  });

  it('a read that returns a deleted task shows "This task was deleted." instead of the task', async () => {
    const r = rig();
    start(r, listOf([1, 2], { total: 2, next_cursor: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Task 1' }));
    // Still on the list while the read is pending: the row is deleted from its menu.
    del('Task 1');
    await act(async () => { r.deletes.t1!.resolve({ kind: 'deleted' }); await tick(); });
    await act(async () => { r.gets.t1!.resolve(task('t1')); await tick(); });
    expect(screen.queryByText('Detail of t1')).toBeNull();
    expect(screen.queryByText('Task 1')).toBeNull();
  });

  it('a host result for a deleted task shows the deleted note', async () => {
    const r = rig();
    let onPayload: (p: TaskPayload) => void = () => {};
    (r.bridge as unknown as { onPayload: unknown }).onPayload = (cb: (p: TaskPayload) => void) => (onPayload = cb);
    start(r, listOf([1, 2], { total: 2, next_cursor: null }));
    del('Task 1');
    await act(async () => { r.deletes.t1!.resolve({ kind: 'deleted' }); await tick(); });
    act(() => onPayload(task('t1')));
    screen.getByText('This task was deleted.');
    expect(screen.queryByText('Detail of t1')).toBeNull();
  });

  it('a failed refill after deleting the visible rows offers Retry with the same cursor', async () => {
    const r = rig();
    start(r, listOf([1], { total: 5, next_cursor: 'c1' }));
    del('Task 1');
    await act(async () => { r.deletes.t1!.resolve({ kind: 'deleted' }); await tick(); });
    expect(r.lists.at(-1)!.q).toEqual({ days: 7, status: null, source: null, cursor: 'c1' });
    await act(async () => { r.lists.at(-1)!.d.resolve({ kind: 'failed', message: 'x' }); await tick(); });
    screen.getByText("Couldn't load more.");
    const n = r.lists.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(r.lists.length).toBe(n + 1);
    expect(r.lists.at(-1)!.q).toEqual({ days: 7, status: null, source: null, cursor: 'c1' });
    await act(async () => { r.lists.at(-1)!.d.resolve({ kind: 'ok', list: listOf([2, 3], { total: 4, shown: 2, next_cursor: null }) }); await tick(); });
    screen.getByText('Task 2');
    expect(screen.queryByText("Couldn't load more.")).toBeNull();
  });

  it('a failed Show more offers Retry too', async () => {
    const r = rig();
    start(r, listOf([1, 2], { total: 5, next_cursor: 'c1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await act(async () => { r.lists[0]!.d.resolve({ kind: 'failed', message: 'x' }); await tick(); });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(r.lists[1]!.q).toEqual({ days: 7, status: null, source: null, cursor: 'c1' });
  });
});

describe('answers survive a same-task host result (review)', () => {
  const asking = (id: string) =>
    ({ ...task(id), status: 'waiting_for_answer',
      open_ask: { ask_id: 'ask_1', kind: 'question', questions: [{ id: 'q', kind: 'confirm', prompt: 'Go ahead?' }] } }) as unknown as TaskPayload;
  function hostRig() {
    const r = rig();
    let onPayload: (p: TaskPayload) => void = () => {};
    const answer = deferred<import('../src/bridge').AnswerOutcome>();
    Object.assign(r.bridge, {
      onPayload: (cb: (p: TaskPayload) => void) => (onPayload = cb),
      answer: vi.fn(() => answer.promise),
    });
    render(<Root makeBridge={() => r.bridge} />);
    act(() => onPayload(asking('t1')));
    act(() => r.ready());
    return { r, answer, payload: (p: TaskPayload) => onPayload(p) };
  }
  const send = () => {
    fireEvent.click(screen.getByLabelText('Yes'));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  };

  it('a refusal still shows and the form unlocks', async () => {
    const h = hostRig();
    send();
    screen.getByRole('button', { name: 'Sending…' });
    act(() => h.payload(asking('t1')));
    await act(async () => { h.answer.resolve({ kind: 'refused', reason: 'Stop the task first.', payload: null }); await tick(); });
    screen.getByText('Stop the task first.');
    expect((screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('an accepted answer still locks as Answered · continuing', async () => {
    const h = hostRig();
    send();
    act(() => h.payload(asking('t1')));
    await act(async () => { h.answer.resolve({ kind: 'accepted', payload: null }); await tick(); });
    screen.getByText('Answered');
    screen.getByText(/· continuing/);
  });

  it('a dropped answer (another task is shown now) never leaves a form stuck on Sending…', async () => {
    const h = hostRig();
    send();
    act(() => h.payload(asking('t2')));
    await act(async () => { h.answer.resolve({ kind: 'refused', reason: 'x', payload: null }); await tick(); });
    expect(screen.queryByRole('button', { name: 'Sending…' })).toBeNull();
    screen.getByRole('button', { name: 'Send answer' });
  });
});

describe('a failed delete after a filter change (review)', () => {
  it('still shows its error on the row', async () => {
    const r = rig();
    start(r, listOf([1, 2], { total: 2, next_cursor: null }));
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Task 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.change(screen.getByLabelText('Status') as HTMLSelectElement, { target: { value: '3' } });
    await act(async () => { r.deletes.t1!.resolve({ kind: 'failed', message: "Couldn't delete the task. Try again." }); await tick(); });
    screen.getByText("Couldn't delete the task. Try again.");
    screen.getByText('Task 1');
  });
});
