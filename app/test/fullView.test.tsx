import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bridge, ListQuery } from '../src/bridge';
import { parseList, type ListPayload } from '../src/list';
import { Root, SEARCH_UNAVAILABLE } from '../src/Root';
import type { TaskPayload } from '../src/types';
import { SEARCH_DEBOUNCE_MS, STOP_FIRST_NOTE } from '../src/view/FullView';

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

const task = (id: string, o: Record<string, unknown> = {}) => ({
  task_id: id, status: 'done', title: `Task ${id}`, plan: [], sections: [], live: null, estimate: null, open_ask: null,
  deliverables: [], result: { summary: `Result of ${id}`, summary_type: 'text', takeaway: null }, work_ms: 60000,
  usage: null, events: [], cursor: 1, more: false, ...o,
  view: { token: `view-${id}`, url: `https://api.example.com/v1/runs/${id}/view`, expires_in_s: 1800 },
  prompt_access: { token: `tok-${id}`, url: `https://api.example.com/v1/runs/${id}/prompt` },
}) as unknown as TaskPayload;
const row = (id: string, o: Record<string, unknown> = {}) => ({
  task_id: id, title: `Task ${id}`, status: 'done', started_at: '2026-11-06T09:42:00Z', source: 'claude', work_ms: 60000, turn: 1, ...o,
});
const listOf = (items: unknown[], filters: Record<string, unknown> = { days: 7, status: null, source: null, query: null }): ListPayload =>
  parseList({ view: 'list', items, total: items.length, shown: items.length, next_cursor: null, filters, capped: false, org: 'Acme' })!;

type PromptReply = { status: number; prompt?: unknown; truncated?: boolean };
function rig(o: { modes?: string[]; grant?: string; prompts?: Record<string, PromptReply>; tasks?: Record<string, TaskPayload>; wideAfterGrant?: boolean } = {}) {
  let onPayload: (p: TaskPayload) => void = () => {};
  let onList: (l: ListPayload) => void = () => {};
  let onReady: () => void = () => {};
  let onMode: (m: string) => void = () => {};
  let mode = 'inline';
  let wide = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const m = /\/v1\/runs\/([^/]+)\/prompt$/.exec(url);
    const id = m?.[1] ?? '';
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    const reply: PromptReply = auth === `Bearer tok-${id}` ? (o.prompts?.[id] ?? { status: 200, prompt: `Prompt for ${id}` }) : { status: 401 };
    return { status: reply.status, ok: reply.status === 200, json: async () => ({ prompt: reply.prompt, truncated: reply.truncated ?? false }) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  window.matchMedia = ((q: string) => ({ matches: !wide, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  const tasks: Record<string, TaskPayload> = o.tasks ?? { a: task('a'), b: task('b'), c: task('c', { status: 'running', result: null }) };
  const bridge = {
    onPayload: (cb: typeof onPayload) => (onPayload = cb),
    getTask: vi.fn(async (id: string) => tasks[id] ?? null),
    theme: () => 'light' as const,
    onThemeChange: () => {},
    onConnectError: () => {},
    canCallTools: () => true,
    onReady: (cb: () => void) => (onReady = cb),
    answer: async () => ({ kind: 'failed' as const, message: '' }),
    onList: (cb: typeof onList) => (onList = cb),
    listTasks: vi.fn(async (q: ListQuery) => ({ kind: 'ok' as const, list: listOf([row('a'), row('b')], { days: q.days, status: null, source: null, query: q.query ?? null }) })),
    deleteTask: vi.fn(async () => ({ kind: 'deleted' as const })),
    fileLink: vi.fn(async () => ({ kind: 'failed' as const, message: 'x' })),
    openLink: async () => false,
    displayModes: () => o.modes ?? ['inline', 'fullscreen'],
    displayMode: () => mode,
    requestDisplayMode: vi.fn(async (m: string) => {
      mode = m === 'fullscreen' ? (o.grant ?? 'fullscreen') : m;
      // An inline card is narrow; the host widens the frame only once it grants full screen.
      wide = mode === 'fullscreen' && o.wideAfterGrant !== false;
      return mode;
    }),
    onDisplayModeChange: (cb: typeof onMode) => (onMode = cb),
    stopTask: vi.fn(async () => true),
    checkTask: vi.fn(async () => 'ok' as const),
  };
  return {
    fetch: fetchMock,
    bridge: bridge as unknown as Bridge & typeof bridge,
    payload: (p: TaskPayload) => act(() => onPayload(p)),
    list: (l: ListPayload) => act(() => onList(l)),
    ready: () => act(() => onReady()),
    hostLeaves: () => act(() => { mode = 'inline'; onMode('inline'); }),
  };
}

beforeEach(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openFull(r: ReturnType<typeof rig>, items = [row('a'), row('b'), row('c', { status: 'running' })]) {
  render(<Root makeBridge={() => r.bridge} />);
  await r.ready();
  await r.list(listOf(items));
  fireEvent.click(document.querySelector('.fc-expand')!);
  await settle();
}
/** Past the host's full-screen grant and the first task's load. */
const settle = flush;

describe('the full-screen task list', () => {
  it('Expand asks for full screen and shows the list beside the first task, with its prompt', async () => {
    const r = rig();
    await openFull(r);
    expect(r.bridge.requestDisplayMode).toHaveBeenCalledWith('fullscreen');
    expect(document.querySelector('.fc-full')).not.toBeNull();
    expect(document.querySelectorAll('.fc-frow').length).toBe(3);
    expect(document.querySelector('.fc-frow-on')!.getAttribute('data-task')).toBe('a');
    screen.getByText('Result of a');
    expect(document.querySelector('.fc-prompt-text')!.textContent).toBe('Prompt for a');
    expect(document.querySelector('.fc-full-pane .fc-pill')).toBeNull(); // no status pill in the pane
  });

  it('no Expand without full screen; a refusal keeps the in-card list', async () => {
    const none = rig({ modes: ['inline'] });
    render(<Root makeBridge={() => none.bridge} />);
    await none.ready();
    await none.list(listOf([row('a')]));
    expect(document.querySelector('.fc-expand')).toBeNull();
    cleanup();
    const refused = rig({ grant: 'inline' });
    await openFull(refused);
    expect(document.querySelector('.fc-full')).toBeNull();
    expect(document.querySelector('.fc-head-list')).not.toBeNull();
  });

  it('selecting another task loads it and its prompt; a late answer for the old one is dropped', async () => {
    let release: (v: TaskPayload) => void = () => {};
    const r = rig();
    await openFull(r);
    r.bridge.getTask.mockImplementationOnce(() => new Promise<TaskPayload>((res) => { release = res; }));
    fireEvent.click(document.querySelector('.fc-frow[data-task="b"] .fc-frow-open')!);
    fireEvent.click(document.querySelector('.fc-frow[data-task="a"] .fc-frow-open')!);
    await flush();
    release(task('b'));
    await flush();
    expect(document.querySelector('.fc-frow-on')!.getAttribute('data-task')).toBe('a');
    expect(screen.queryByText('Result of b')).toBeNull();
    screen.getByText('Result of a');
  });

  it('a prompt that fails to load leaves the section out; a prompt is text, not markup', async () => {
    const r = rig({ prompts: { a: { status: 500 }, b: { status: 200, prompt: '<img src=x onerror=alert(1)>\nline two' } } });
    await openFull(r);
    expect(document.querySelector('.fc-prompt')).toBeNull();
    fireEvent.click(document.querySelector('.fc-frow[data-task="b"] .fc-frow-open')!);
    await flush();
    const p = document.querySelector('.fc-prompt-text')!;
    expect(p.querySelector('img')).toBeNull();
    expect(p.textContent).toBe('<img src=x onerror=alert(1)>\nline two');
  });

  it('Delete from the pane confirms, deletes, removes the row and opens the next task', async () => {
    const r = rig();
    await openFull(r);
    fireEvent.click(screen.getByText('Delete task'));
    screen.getByText('Delete "Task a"?');
    fireEvent.click(screen.getByText('Delete'));
    await flush();
    expect(r.bridge.deleteTask).toHaveBeenCalledWith('a');
    expect(document.querySelector('.fc-frow[data-task="a"]')).toBeNull();
    expect(document.querySelector('.fc-frow-on')!.getAttribute('data-task')).toBe('b');
    screen.getByText('Deleted “Task a”.');
  });

  it('the row bin confirms inside its own row; a refusal shows there and keeps the row', async () => {
    const r = rig();
    r.bridge.deleteTask.mockResolvedValueOnce({ kind: 'refused', reason: 'Stop the task first.' } as never);
    await openFull(r);
    fireEvent.click(document.querySelector('.fc-frow[data-task="b"] .fc-bin')!);
    const rowConfirm = document.querySelector('.fc-frow-confirm[data-task="b"]')!;
    expect(rowConfirm).not.toBeNull();
    expect(rowConfirm.textContent).toContain('Delete "Task b"?');
    expect(document.querySelector('.fc-pane-confirm')).toBeNull(); // not in the pane
    expect(document.querySelector('.fc-frow-on')!.getAttribute('data-task')).toBe('a'); // selection unchanged
    const buttons = Array.from(rowConfirm.querySelectorAll('.fc-confirm-b button')).map((b) => b.textContent);
    expect(buttons).toEqual(['Cancel', 'Delete']);
    fireEvent.click(rowConfirm.querySelector('.fc-danger')!);
    await flush();
    expect(document.querySelector('.fc-frow-confirm[data-task="b"]')!.textContent).toContain('Stop the task first.');
    fireEvent.click(screen.getByText('Cancel'));
    expect(document.querySelector('.fc-frow-confirm')).toBeNull();
    expect(document.querySelector('.fc-frow[data-task="b"]')).not.toBeNull();
  });

  it('a row confirm deletes that row without moving the pane; a running row says to stop it first', async () => {
    const r = rig();
    await openFull(r);
    fireEvent.click(document.querySelector('.fc-frow[data-task="b"] .fc-bin')!);
    fireEvent.click(document.querySelector('.fc-frow-confirm[data-task="b"] .fc-danger')!);
    await flush();
    expect(r.bridge.deleteTask).toHaveBeenCalledWith('b');
    expect(document.querySelector('.fc-frow[data-task="b"]')).toBeNull();
    expect(document.querySelector('.fc-frow-on')!.getAttribute('data-task')).toBe('a');
    fireEvent.click(document.querySelector('.fc-frow[data-task="c"] .fc-bin')!);
    expect(document.querySelector('.fc-frow[data-task="c"]')!.textContent).toContain('Stop it first, then delete it.');
    expect(document.querySelector('.fc-frow-confirm')).toBeNull();
  });

  it('a running task offers Stop; Delete explains instead of asking', async () => {
    const r = rig();
    await openFull(r);
    fireEvent.click(document.querySelector('.fc-frow[data-task="c"] .fc-frow-open')!);
    await flush();
    fireEvent.click(screen.getByText('Delete task'));
    screen.getByText(STOP_FIRST_NOTE);
    expect(screen.queryByText(/^Delete "/)).toBeNull();
    fireEvent.click(screen.getByText('Stop task'));
    await flush();
    expect(r.bridge.stopTask).toHaveBeenCalledWith('c');
  });

  it('a deleted row is faded, marked and never selectable', async () => {
    const r = rig();
    await openFull(r, [row('a'), row('z', { deleted: true })]);
    const z = document.querySelector('.fc-frow[data-task="z"]')!;
    expect(z.classList.contains('fc-row-deleted')).toBe(true);
    expect(z.querySelector('button')).toBeNull();
    expect(z.textContent).toContain('Deleted');
  });

  it('search waits for typing to pause, sends the query and shows the matches', async () => {
    const r = rig();
    await openFull(r);
    vi.useFakeTimers();
    const input = document.querySelector('.fc-search-input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'me' } });
    fireEvent.input(input, { target: { value: 'memo' } });
    expect(r.bridge.listTasks).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
    vi.useRealTimers();
    await flush();
    expect(r.bridge.listTasks).toHaveBeenCalledTimes(1);
    expect(r.bridge.listTasks.mock.calls[0]![0]).toMatchObject({ days: 7, query: 'memo' });
    expect(document.querySelector('.fc-full-cap')!.textContent).toBe('2 matches · newest first');
  });

  it('an older server that ignores the query says search is unavailable and keeps the rows', async () => {
    const r = rig();
    r.bridge.listTasks.mockResolvedValueOnce({ kind: 'ok', list: { ...listOf([row('q')]), searchable: false } } as never);
    await openFull(r);
    vi.useFakeTimers();
    fireEvent.input(document.querySelector('.fc-search-input')!, { target: { value: 'memo' } });
    await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
    vi.useRealTimers();
    await flush();
    screen.getByText(SEARCH_UNAVAILABLE);
    expect(document.querySelector('.fc-frow[data-task="q"]')).toBeNull();
    expect(document.querySelector('.fc-frow[data-task="a"]')).not.toBeNull();
  });

  it('Exit returns to the inline list; the host leaving full screen does too', async () => {
    const r = rig();
    await openFull(r);
    fireEvent.click(screen.getByText('Exit full screen'));
    await flush();
    expect(r.bridge.requestDisplayMode).toHaveBeenLastCalledWith('inline');
    expect(document.querySelector('.fc-full')).toBeNull();
    expect(document.querySelector('.fc-head-list')).not.toBeNull();
    fireEvent.click(document.querySelector('.fc-expand')!);
    await settle();
    expect(document.querySelector('.fc-full')).not.toBeNull();
    await r.hostLeaves();
    expect(document.querySelector('.fc-full')).toBeNull();
  });
});

describe('the finished card strip and the deleted card', () => {
  const finished = task('a', { stats: { d7: 12, d30: 31 } });

  it('shows the counts as links that open the list over their own window, full screen, on the finished task', async () => {
    const r = rig();
    render(<Root makeBridge={() => r.bridge} />);
    await r.ready();
    await r.payload(finished);
    await flush();
    const links = Array.from(document.querySelectorAll('.fc-strip-link')).map((b) => b.textContent);
    expect(links).toEqual(['12 in the last 7 days', '31 in the last 30 days', 'View all →']);
    fireEvent.click(screen.getByText('12 in the last 7 days'));
    await settle();
    expect(r.bridge.listTasks).toHaveBeenCalledWith({ days: 7 });
    expect(document.querySelector('.fc-full')).not.toBeNull();
    expect(document.querySelector('.fc-frow-on')!.getAttribute('data-task')).toBe('a');
    fireEvent.click(screen.getByText('Exit full screen'));
    await flush();
    screen.getByText('Result of a'); // back on the chat's own task card
    expect(document.querySelector('.fc-strip')).not.toBeNull();
  });

  it('no strip without counts or without tool calls; a running card has none', async () => {
    const r = rig();
    render(<Root makeBridge={() => r.bridge} />);
    await r.ready();
    await r.payload(task('a'));
    await flush();
    expect(document.querySelector('.fc-strip')).toBeNull();
    await r.payload(task('c', { status: 'running', result: null, stats: { d7: 1, d30: 1 } }));
    expect(document.querySelector('.fc-strip')).toBeNull();
  });

  it('a finished card whose task was deleted elsewhere turns into the deleted card, keeping the strip', async () => {
    const r = rig();
    r.bridge.checkTask.mockResolvedValue('deleted' as never);
    render(<Root makeBridge={() => r.bridge} />);
    await r.ready();
    await r.payload(finished);
    await flush();
    expect(r.bridge.checkTask).toHaveBeenCalledWith('a');
    screen.getByText('This task was deleted');
    screen.getByText('Its results and files have been removed.');
    expect(screen.queryByText('Result of a')).toBeNull();
    expect(document.querySelector('.fc-deleted-label')!.textContent).toBe('Deleted');
    expect(document.querySelector('.fc-deleted-label')!.tagName).not.toBe('BUTTON');
    expect(document.querySelector('.fc-strip')).not.toBeNull();
  });

  it('checks again when the card comes back into view; unknown answers change nothing', async () => {
    const r = rig();
    r.bridge.checkTask.mockResolvedValueOnce('unknown' as never).mockResolvedValueOnce('deleted' as never);
    render(<Root makeBridge={() => r.bridge} />);
    await r.ready();
    await r.payload(finished);
    await flush();
    screen.getByText('Result of a');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    screen.getByText('This task was deleted');
  });

  it('a file link that finds the task gone turns the card deleted', async () => {
    const r = rig();
    r.bridge.fileLink.mockResolvedValue({ kind: 'failed', message: 'Gone', gone: true } as never);
    render(<Root makeBridge={() => r.bridge} />);
    await r.ready();
    await r.payload(task('a', { deliverables: [{ name: 'memo.docx', path: 'memo.docx' }] }));
    await flush();
    const btn = Array.from(document.querySelectorAll('button')).find((b) => /download/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);
    await flush();
    screen.getByText('This task was deleted');
  });
});


describe('review fixes (2026-11-07)', () => {
  it('the prompt comes over the prompt key from _meta, never the view token or a host tool call', async () => {
    const r = rig();
    await openFull(r);
    const call = r.fetch.mock.calls.find((c) => String(c[0]).endsWith('/v1/runs/a/prompt'))!;
    expect(call).toBeTruthy();
    expect((call[1]!.headers as Record<string, string>).Authorization).toBe('Bearer tok-a');
    expect(document.querySelector('.fc-prompt-text')!.textContent).toBe('Prompt for a');
    expect('taskPrompt' in r.bridge).toBe(false);
  });

  it('a narrow full screen (Codex side panel) stays open and stacks: list first, then the task with a way back', async () => {
    const r = rig({ wideAfterGrant: false });
    await openFull(r);
    // Codex grants "fullscreen" as a side panel under 900 px: never hand it back inline.
    expect(r.bridge.requestDisplayMode).toHaveBeenCalledTimes(1);
    expect(r.bridge.requestDisplayMode).toHaveBeenLastCalledWith('fullscreen');
    expect(document.querySelector('.fc-full.fc-full-stack')).not.toBeNull();
    // Opened from the list: the list shows, the pane waits.
    expect(document.querySelectorAll('.fc-frow').length).toBe(3);
    expect(document.querySelector('.fc-full-pane')).toBeNull();
    fireEvent.click(document.querySelector('.fc-frow[data-task="b"] .fc-frow-open')!);
    await flush();
    expect(document.querySelector('.fc-full-list')).toBeNull();
    screen.getByText('Result of b');
    fireEvent.click(screen.getByRole('button', { name: 'All tasks' }));
    expect(document.querySelector('.fc-full-pane')).toBeNull();
    expect(document.querySelector('.fc-frow-on')!.getAttribute('data-task')).toBe('b');
  });

  it('a wide full screen keeps both panes side by side', async () => {
    const r = rig();
    await openFull(r);
    expect(document.querySelector('.fc-full-stack')).toBeNull();
    expect(document.querySelector('.fc-full-list')).not.toBeNull();
    expect(document.querySelector('.fc-full-pane')).not.toBeNull();
  });

  it('a file in the full view pane opens its download link', async () => {
    const r = rig({ tasks: { a: task('a', { deliverables: [{ name: 'memo.docx', path: 'memo.docx' }] }) } });
    r.bridge.fileLink.mockResolvedValue({ kind: 'ok', url: 'https://files.example.com/memo.docx', name: 'memo.docx' } as never);
    const open = vi.fn(async () => true);
    (r.bridge as unknown as { openLink: typeof open }).openLink = open;
    await openFull(r, [row('a')]);
    const btn = Array.from(document.querySelectorAll('.fc-full-pane button')).find((b) => /download/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
    fireEvent.click(btn!);
    await flush();
    expect(r.bridge.fileLink).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('https://files.example.com/memo.docx');
  });

  it('a delete that settles after the user picked another task leaves their pick alone', async () => {
    let finish: (v: { kind: 'deleted' }) => void = () => {};
    const r = rig();
    r.bridge.deleteTask.mockImplementationOnce(() => new Promise((res) => { finish = res; }) as never);
    await openFull(r);
    fireEvent.click(screen.getByText('Delete task'));
    fireEvent.click(screen.getByText('Delete')); // deleting a, still in flight
    fireEvent.click(document.querySelector('.fc-frow[data-task="b"] .fc-frow-open')!);
    await flush();
    finish({ kind: 'deleted' });
    await flush();
    expect(document.querySelector('.fc-frow-on')!.getAttribute('data-task')).toBe('b');
    expect(document.querySelector('.fc-frow[data-task="a"]')).toBeNull();
  });

  it('without full screen the strip opens the list in the card, with a way back to the finished task', async () => {
    const r = rig({ grant: 'inline' });
    render(<Root makeBridge={() => r.bridge} />);
    await r.ready();
    await r.payload(task('a', { stats: { d7: 2, d30: 5 } }));
    await flush();
    fireEvent.click(screen.getByText('View all →'));
    await settle();
    expect(document.querySelector('.fc-head-list')).not.toBeNull();
    fireEvent.click(screen.getByText('Back to the task'));
    await flush();
    screen.getByText('Result of a');
  });
});


describe('second review fixes (2026-11-07)', () => {
  it('a search while a task opens does not stop it loading', async () => {
    let release: (v: TaskPayload) => void = () => {};
    const r = rig();
    await openFull(r);
    r.bridge.getTask.mockImplementationOnce(() => new Promise<TaskPayload>((res) => { release = res; }));
    fireEvent.click(document.querySelector('.fc-frow[data-task="b"] .fc-frow-open')!);
    vi.useFakeTimers();
    fireEvent.input(document.querySelector('.fc-search-input')!, { target: { value: 'task' } });
    await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
    vi.useRealTimers();
    await flush();
    expect(r.bridge.listTasks).toHaveBeenCalled();
    release(task('b'));
    await flush();
    screen.getByText('Result of b');
    expect(document.querySelector('.fc-prompt-text')!.textContent).toBe('Prompt for b');
  });

  it('opening a task from the strip\'s in-card list and coming back keeps "Back to the task"', async () => {
    const r = rig({ grant: 'inline' });
    render(<Root makeBridge={() => r.bridge} />);
    await r.ready();
    await r.payload(task('a', { stats: { d7: 2, d30: 5 } }));
    await flush();
    fireEvent.click(screen.getByText('View all →'));
    await settle();
    fireEvent.click(screen.getByText('Task b'));
    await flush();
    fireEvent.click(screen.getByText('All tasks'));
    await flush();
    fireEvent.click(screen.getByText('Back to the task'));
    await flush();
    screen.getByText('Result of a');
  });

  it('a list the host shows has no way back to a card', async () => {
    const r = rig({ grant: 'inline' });
    render(<Root makeBridge={() => r.bridge} />);
    await r.ready();
    await r.payload(task('a', { stats: { d7: 2, d30: 5 } }));
    await flush();
    fireEvent.click(screen.getByText('View all →'));
    await settle();
    await r.list(listOf([row('a')]));
    expect(screen.queryByText('Back to the task')).toBeNull();
  });
});
