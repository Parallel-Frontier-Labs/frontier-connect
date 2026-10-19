import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnswerOutcome, Bridge } from '../src/bridge';
import { Root } from '../src/Root';
import type { TaskPayload } from '../src/types';

function rig(theme: 'light' | 'dark' = 'light', tools = false, answer: Bridge['answer'] = async () => ({ kind: 'accepted', payload: null })) {
  let onPayload: (p: TaskPayload) => void = () => {};
  let onReady: () => void = () => {};
  let onTheme: (t: 'light' | 'dark') => void = () => {};
  let onErr: (e: unknown) => void = () => {};
  let cur = theme;
  const bridge: Bridge = {
    onPayload: (cb) => (onPayload = cb),
    getTask: async () => null,
    theme: () => cur,
    onThemeChange: (cb) => (onTheme = cb),
    onConnectError: (cb) => (onErr = cb),
    canCallTools: () => tools,
    onReady: (cb) => (onReady = cb),
    answer: vi.fn(answer),
    onList: () => {},
    listTasks: async () => ({ kind: 'failed', message: '' }),
    deleteTask: async () => ({ kind: 'failed', message: '' }),
    fileLink: async () => ({ kind: 'failed', message: '' }),
    openLink: async () => false,
  };
  return {
    bridge,
    payload: (p: TaskPayload) => onPayload(p),
    theme: (t: 'light' | 'dark') => ((cur = t), onTheme(t)),
    fail: (e: unknown) => onErr(e),
    ready: () => onReady(),
  };
}

const done = {
  task_id: 't1', status: 'done', title: 'Quarterly review', plan: [], sections: [], live: null,
  estimate: null, open_ask: null, deliverables: [], result: null, work_ms: 0, usage: null,
  events: [], cursor: 1, more: false, view: null,
} as unknown as TaskPayload;

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

describe('Root', () => {
  it('updates data-theme when the host theme changes', () => {
    const r = rig('light');
    render(<Root makeBridge={() => r.bridge} />);
    expect(document.documentElement.dataset.theme).toBe('light');
    act(() => r.theme('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('shows a connect error instead of loading forever', () => {
    const r = rig();
    render(<Root makeBridge={() => r.bridge} />);
    expect(screen.getByText(/Loading the task/)).toBeTruthy();
    act(() => r.fail(new Error('no host')));
    expect(screen.getByText("Couldn't connect to the chat app. Reload the conversation.")).toBeTruthy();
    expect(screen.queryByText(/Loading the task/)).toBeNull();
  });

  it('keeps showing the card if a payload arrived before the error', () => {
    const r = rig();
    render(<Root makeBridge={() => r.bridge} />);
    act(() => r.payload(done));
    act(() => r.fail(new Error('late')));
    expect(screen.getByText('Quarterly review')).toBeTruthy();
  });

  it('renders at once from a payload handed over before mount effects ran', () => {
    const r = rig();
    let handed: ((p: TaskPayload) => void) | null = null;
    const bridge: Bridge = {
      ...r.bridge,
      // Like the host bridge: a result received before registration is replayed on registration.
      onPayload: (cb) => { handed = cb; cb(done); },
    };
    render(<Root makeBridge={() => bridge} />);
    expect(handed).not.toBeNull();
    expect(screen.getByText('Quarterly review')).toBeTruthy();
    expect(screen.queryByText(/Loading the task/)).toBeNull();
  });

  const waiting = {
    ...done, status: 'waiting_for_answer', view: null,
    open_ask: { ask_id: 'ask_1', kind: 'question', questions: [{ id: 'q', kind: 'confirm', prompt: 'Go ahead?' }] },
  } as unknown as TaskPayload;

  it('offers Send only once the host says it forwards app tool calls', () => {
    const r = rig('light', true);
    render(<Root makeBridge={() => r.bridge} />);
    act(() => r.payload(waiting));
    screen.getByText('Reply in the chat to answer.');
    act(() => r.ready());
    screen.getByRole('button', { name: 'Send answer' });
  });

  it('a host without app tool calls keeps the chat fallback after the handshake', () => {
    const r = rig('light', false);
    render(<Root makeBridge={() => r.bridge} />);
    act(() => r.payload(waiting));
    act(() => r.ready());
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull();
    screen.getByText('Reply in the chat to answer.');
  });

  it('sends the answer for this task and folds the returned payload in', async () => {
    const fresh = { ...waiting, status: 'running', open_ask: null, title: 'Carrying on', cursor: 9 } as unknown as TaskPayload;
    const r = rig('light', true, async (): Promise<AnswerOutcome> => ({ kind: 'accepted', payload: fresh }));
    render(<Root makeBridge={() => r.bridge} />);
    act(() => r.payload(waiting));
    act(() => r.ready());
    fireEvent.click(screen.getByLabelText('Yes'));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
    expect(r.bridge.answer).toHaveBeenCalledWith('t1', 'ask_1', [{ questionId: 'q', kind: 'confirm', value: true }]);
    screen.getByText('Carrying on');
    screen.getByText('Answered');
  });
});

describe('Root: your Frontier tasks', () => {
  const listOf = (ids: number[], o: Record<string, unknown> = {}) => ({
    view: 'list',
    items: ids.map((n) => ({ task_id: `t${n}`, title: `Task ${n}`, status: 'done', started_at: '2026-10-18T09:42:00Z', source: 'claude', work_ms: 1000, turn: 1 })),
    total: 12, shown: ids.length, next_cursor: 'c1', filters: { days: 7, status: null, source: null }, capped: false, ...o,
  });
  function listRig() {
    let onList: (l: unknown) => void = () => {};
    let onReady: () => void = () => {};
    const bridge = {
      onPayload: () => {},
      getTask: vi.fn(async (id: string) => ({ ...done, task_id: id, title: `Detail of ${id}` }) as TaskPayload),
      theme: () => 'light' as const,
      onThemeChange: () => {},
      onConnectError: () => {},
      canCallTools: () => true,
      onReady: (cb: () => void) => (onReady = cb),
      answer: async () => ({ kind: 'failed' as const, message: '' }),
      onList: (cb: (l: unknown) => void) => (onList = cb),
      listTasks: vi.fn(async (q: { cursor?: string | null }) => ({
        kind: 'ok' as const,
        list: (q.cursor ? listOf([3, 4], { shown: 4, next_cursor: null }) : listOf([1, 2])) as never,
      })),
      deleteTask: vi.fn(async () => ({ kind: 'deleted' as const })),
    };
    return { bridge: bridge as unknown as Bridge & typeof bridge, list: (l: unknown) => onList(l), ready: () => onReady() };
  }
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  it('a list tool result shows the list; Show more appends; opening a task and going back keeps the loaded rows', async () => {
    const r = listRig();
    const { parseList } = await import('../src/list');
    render(<Root makeBridge={() => r.bridge} />);
    act(() => r.list(parseList(listOf([1, 2]))));
    act(() => r.ready());
    screen.getByText('Your Frontier tasks');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await flush();
    expect(r.bridge.listTasks).toHaveBeenCalledWith({ days: 7, status: null, source: null, cursor: 'c1' });
    screen.getByText('Task 4');
    screen.getByText('4 of 12');
    fireEvent.click(screen.getByRole('button', { name: 'Task 3' }));
    await flush();
    expect(r.bridge.getTask).toHaveBeenCalledWith('t3', 0);
    screen.getByText('Detail of t3');
    fireEvent.click(screen.getByRole('button', { name: 'All tasks' }));
    screen.getByText('Your Frontier tasks');
    screen.getByText('Task 4');
    screen.getByText('4 of 12');
    expect(document.activeElement?.textContent).toBe('Task 3');
  });

  it('a task opened from a plain task result has no back bar', async () => {
    const r = rig();
    render(<Root makeBridge={() => r.bridge} />);
    act(() => r.payload(done));
    expect(screen.queryByRole('button', { name: 'All tasks' })).toBeNull();
  });

  it('deleting removes the row and lowers the count', async () => {
    const r = listRig();
    const { parseList } = await import('../src/list');
    render(<Root makeBridge={() => r.bridge} />);
    act(() => r.list(parseList(listOf([1, 2]))));
    act(() => r.ready());
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Task 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await flush();
    expect(r.bridge.deleteTask).toHaveBeenCalledWith('t1');
    expect(screen.queryByText('Task 1')).toBeNull();
    screen.getByText('1 of 11');
  });

  it('before the host forwards tool calls the list is read-only', async () => {
    const r = listRig();
    const { parseList } = await import('../src/list');
    render(<Root makeBridge={() => r.bridge} />);
    act(() => r.list(parseList(listOf([1]))));
    screen.getByText('Ask in the chat to filter or open a task');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a delete the bridge reports as done (also task_not_found: deleted elsewhere) removes the row with no error', async () => {
    const r = listRig();
    (r.bridge.deleteTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: 'deleted' });
    const { parseList } = await import('../src/list');
    render(<Root makeBridge={() => r.bridge} />);
    act(() => r.list(parseList(listOf([1, 2]))));
    act(() => r.ready());
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Task 2' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await flush();
    expect(screen.queryByText('Task 2')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    screen.getByText('1 of 11');
  });
});
