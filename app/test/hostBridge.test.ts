import { describe, expect, it, vi } from 'vitest';
import type { App } from '@modelcontextprotocol/ext-apps';
import { createHostBridge, DELETE_FAILED, LIST_FAILED, promptAccessOf, SEND_FAILED } from '../src/hostBridge';
import type { TaskPayload } from '../src/types';

const payload = { task_id: 't', status: 'running', cursor: 4 } as unknown as TaskPayload;

function fake(over: Record<string, unknown> = {}) {
  const app: Record<string, unknown> = {
    connect: vi.fn().mockResolvedValue(undefined),
    callServerTool: vi.fn(),
    getHostContext: vi.fn(() => ({ theme: 'dark' })),
    ...over,
  };
  return app as unknown as App & {
    ontoolresult: (r: unknown) => void;
    callServerTool: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    getHostContext: ReturnType<typeof vi.fn>;
  };
}

describe('createHostBridge', () => {
  it('connects and forwards payload tool results only', () => {
    const app = fake();
    const b = createHostBridge(app);
    const got: TaskPayload[] = [];
    b.onPayload((p) => got.push(p));
    expect(app.connect).toHaveBeenCalled();
    app.ontoolresult({ structuredContent: payload });
    app.ontoolresult({ structuredContent: { status: 'running' } });
    app.ontoolresult({ content: [] });
    expect(got).toMatchObject([payload]);
  });

  it('replays a tool result that arrived before onPayload was registered', () => {
    const app = fake();
    const b = createHostBridge(app);
    app.ontoolresult({ structuredContent: payload });
    const got: TaskPayload[] = [];
    b.onPayload((p) => got.push(p));
    expect(got).toMatchObject([payload]);
  });

  it('getTask calls frontier_get_task and returns the payload', async () => {
    const app = fake();
    app.callServerTool.mockResolvedValue({ structuredContent: payload });
    const r = await createHostBridge(app).getTask('t', 4);
    expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'frontier_get_task',
      arguments: { task_id: 't', after: 4 },
    });
    expect(r).toMatchObject(payload);
  });

  it('getTask returns null on an error result', async () => {
    const app = fake();
    app.callServerTool.mockResolvedValue({ isError: true, structuredContent: payload });
    expect(await createHostBridge(app).getTask('t', 0)).toBeNull();
  });

  it('safeArea gives the host safe-area insets, or undefined when missing or garbled', () => {
    const app = fake({ getHostContext: vi.fn(() => ({ safeAreaInsets: { top: 16, right: 16, bottom: 88, left: 16 } })) });
    const b = createHostBridge(app);
    expect(b.safeArea?.()).toEqual({ top: 16, right: 16, bottom: 88, left: 16 });
    app.getHostContext.mockReturnValue({});
    expect(b.safeArea?.()).toBeUndefined();
    app.getHostContext.mockReturnValue({ safeAreaInsets: 'wide' });
    expect(b.safeArea?.()).toBeUndefined();
    app.getHostContext.mockReturnValue({ safeAreaInsets: { top: 16, right: 'x', bottom: 88, left: 16 } });
    expect(b.safeArea?.()).toBeUndefined();
    app.getHostContext.mockReturnValue(undefined);
    expect(b.safeArea?.()).toBeUndefined();
  });

  it('theme maps the host context', () => {
    const app = fake();
    const b = createHostBridge(app);
    expect(b.theme()).toBe('dark');
    app.getHostContext.mockReturnValue({ theme: 'light' });
    expect(b.theme()).toBe('light');
    app.getHostContext.mockReturnValue(undefined);
    expect(b.theme()).toBe('light');
  });

  it('with no theme from the host, follows the system setting instead of assuming light', () => {
    const saved = window.matchMedia;
    let dark = true;
    window.matchMedia = ((q: string) => ({ matches: q === '(prefers-color-scheme: dark)' && dark })) as unknown as typeof window.matchMedia;
    try {
      const app = fake({ getHostContext: vi.fn(() => undefined) });
      const b = createHostBridge(app);
      expect(b.theme()).toBe('dark');
      app.getHostContext.mockReturnValue({ displayMode: 'inline' });
      expect(b.theme()).toBe('dark');
      dark = false;
      expect(b.theme()).toBe('light');
      // A theme the host does send always wins.
      dark = true;
      app.getHostContext.mockReturnValue({ theme: 'light' });
      expect(b.theme()).toBe('light');
      // A context change with no theme anywhere keeps following the system.
      const seen: string[] = [];
      b.onThemeChange((t) => seen.push(t));
      app.getHostContext.mockReturnValue({ locale: 'fr' });
      (app as unknown as { onhostcontextchanged: (p: unknown) => void }).onhostcontextchanged({ locale: 'fr' });
      expect(seen).toEqual(['dark']);
    } finally {
      window.matchMedia = saved;
    }
  });

  it('toolName reads the called tool from the host context, when the host sends it', () => {
    const app = fake();
    const b = createHostBridge(app);
    expect(b.toolName!()).toBeUndefined();
    app.getHostContext.mockReturnValue({ toolInfo: { id: 1, tool: { name: 'frontier_list_tasks', inputSchema: {} } } });
    expect(b.toolName!()).toBe('frontier_list_tasks');
    app.getHostContext.mockReturnValue({ toolInfo: { tool: { name: 42 } } });
    expect(b.toolName!()).toBeUndefined();
  });

  it('embedded: inside the host frame unless the host says fullscreen', () => {
    const app = fake();
    const b = createHostBridge(app);
    expect(b.embedded!()).toBe(true); // no displayMode
    app.getHostContext.mockReturnValue(undefined);
    expect(b.embedded!()).toBe(true);
    for (const [displayMode, want] of [['inline', true], ['pip', true], ['fullscreen', false]] as const) {
      app.getHostContext.mockReturnValue({ displayMode });
      expect(b.embedded!()).toBe(want);
    }
  });

  it('onEmbeddedChange follows displayMode changes only', () => {
    const app = fake();
    const b = createHostBridge(app);
    const seen: boolean[] = [];
    b.onEmbeddedChange!((e) => seen.push(e));
    const fire = (app as unknown as { onhostcontextchanged: (p: unknown) => void }).onhostcontextchanged;
    fire({ displayMode: 'fullscreen' });
    fire({ theme: 'dark' }); // no displayMode in the delta: no frame change
    fire({ displayMode: 'inline' });
    expect(seen).toEqual([false, true]);
  });

  it('survives a failed connect', async () => {
    const app = fake({ connect: vi.fn().mockRejectedValue(new Error('no host')) });
    expect(() => createHostBridge(app)).not.toThrow();
    await Promise.resolve();
  });

  it('onThemeChange follows onhostcontextchanged', () => {
    const app = fake();
    const b = createHostBridge(app);
    const seen: string[] = [];
    b.onThemeChange((t) => seen.push(t));
    const fire = (app as unknown as { onhostcontextchanged: (p: unknown) => void }).onhostcontextchanged;
    fire({ theme: 'light' });
    fire({ theme: 'dark' });
    app.getHostContext.mockReturnValue({ theme: 'light' });
    fire({ locale: 'fr' }); // no theme in the delta: read the merged context
    expect(seen).toEqual(['light', 'dark', 'light']);
  });

  it('onConnectError fires on a rejected connect, even when registered late', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = fake({ connect: vi.fn().mockRejectedValue(new Error('no host')) });
    const b = createHostBridge(app);
    const early = vi.fn();
    b.onConnectError(early);
    await new Promise((r) => setTimeout(r, 0));
    const late = vi.fn();
    b.onConnectError(late);
    expect(early).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('canCallTools follows the host serverTools capability, after the handshake', async () => {
    const app = fake({ getHostCapabilities: vi.fn(() => ({ serverTools: {} })) });
    const b = createHostBridge(app);
    expect(b.canCallTools()).toBe(false);
    const ready = vi.fn();
    b.onReady(ready);
    await new Promise((r) => setTimeout(r, 0));
    expect(ready).toHaveBeenCalledTimes(1);
    expect(b.canCallTools()).toBe(true);
    const late = vi.fn();
    b.onReady(late);
    expect(late).toHaveBeenCalledTimes(1);
    const none = createHostBridge(fake({ getHostCapabilities: vi.fn(() => ({})) }));
    await new Promise((r) => setTimeout(r, 0));
    expect(none.canCallTools()).toBe(false);
  });

  it('answer calls frontier_answer and maps accepted, refused and errors', async () => {
    const app = fake();
    const b = createHostBridge(app);
    app.callServerTool.mockResolvedValueOnce({ structuredContent: { ...payload, accepted: true } });
    const ok = await b.answer('t', 'ask_1', [{ questionId: 'q', kind: 'confirm', value: true }]);
    expect(app.callServerTool).toHaveBeenCalledWith({
      name: 'frontier_answer',
      arguments: { task_id: 't', ask_id: 'ask_1', answers: [{ questionId: 'q', kind: 'confirm', value: true }] },
    });
    expect(ok.kind).toBe('accepted');
    expect(ok.kind === 'accepted' && ok.payload?.task_id).toBe('t');

    app.callServerTool.mockResolvedValueOnce({ structuredContent: { ...payload, accepted: false, reason: 'Already answered.' } });
    expect(await b.answer('t', 'ask_1', { deferred: true })).toMatchObject({ kind: 'refused', reason: 'Already answered.' });

    app.callServerTool.mockResolvedValueOnce({ isError: true, structuredContent: { error: { code: 'invalid_state', message: 'This form cannot be put off.' } } });
    expect(await b.answer('t', 'ask_1', { deferred: true })).toEqual({ kind: 'failed', message: 'This form cannot be put off.' });

    app.callServerTool.mockResolvedValueOnce({ isError: true, structuredContent: { error: { message: { x: 1 } } } });
    expect(await b.answer('t', 'ask_1', { values: {} })).toEqual({ kind: 'failed', message: SEND_FAILED });

    app.callServerTool.mockRejectedValueOnce(new Error('timeout'));
    expect(await b.answer('t', 'ask_1', { values: {} })).toEqual({ kind: 'failed', message: SEND_FAILED });

    app.callServerTool.mockResolvedValueOnce({ structuredContent: { weird: true } });
    expect(await b.answer('t', 'ask_1', { values: {} })).toEqual({ kind: 'failed', message: SEND_FAILED });
    // Never retried.
    expect(app.callServerTool).toHaveBeenCalledTimes(6);
  });

  const list = { view: 'list', items: [{ task_id: 't1', title: 'A', status: 'done', started_at: '2026-10-18T09:00:00Z', source: 'claude', work_ms: 1, turn: 1 }],
    total: 1, shown: 1, next_cursor: null, filters: { days: 7, status: null, source: null }, capped: false };

  it('routes list results to onList (replayed when registered late) and task results to onPayload', () => {
    const app = fake();
    const b = createHostBridge(app);
    app.ontoolresult({ structuredContent: list });
    const lists: unknown[] = [];
    const tasks: unknown[] = [];
    b.onList((l) => lists.push(l));
    b.onPayload((p) => tasks.push(p));
    expect(lists.length).toBe(1);
    expect(tasks.length).toBe(0);
    app.ontoolresult({ structuredContent: payload });
    expect(tasks.length).toBe(1);
    expect(lists.length).toBe(1);
  });

  it('listTasks sends only the set filters and maps errors', async () => {
    const app = fake();
    const b = createHostBridge(app);
    app.callServerTool.mockResolvedValueOnce({ structuredContent: list });
    const ok = await b.listTasks({ days: 30, status: 'done', source: null, cursor: null });
    expect(app.callServerTool).toHaveBeenCalledWith({ name: 'frontier_list_tasks', arguments: { days: 30, status: 'done' } });
    expect(ok.kind === 'ok' && ok.list.items[0]!.task_id).toBe('t1');
    app.callServerTool.mockResolvedValueOnce({ structuredContent: list });
    await b.listTasks({ days: 7, cursor: 'abc' });
    expect(app.callServerTool).toHaveBeenLastCalledWith({ name: 'frontier_list_tasks', arguments: { days: 7, cursor: 'abc' } });
    app.callServerTool.mockResolvedValueOnce({ isError: true, structuredContent: { error: { code: 'invalid_state', message: 'That cursor belongs to other filters.' } } });
    expect(await b.listTasks({ days: 7 })).toEqual({ kind: 'failed', message: 'That cursor belongs to other filters.' });
    app.callServerTool.mockRejectedValueOnce(new Error('x'));
    expect(await b.listTasks({ days: 7 })).toEqual({ kind: 'failed', message: LIST_FAILED });
    app.callServerTool.mockResolvedValueOnce({ structuredContent: payload });
    expect(await b.listTasks({ days: 7 })).toEqual({ kind: 'failed', message: LIST_FAILED });
  });

  it('deleteTask calls frontier_delete_task once and maps accepted, refused and errors', async () => {
    const app = fake();
    const b = createHostBridge(app);
    app.callServerTool.mockResolvedValueOnce({ structuredContent: { task_id: 't1', accepted: true } });
    expect(await b.deleteTask('t1')).toEqual({ kind: 'deleted' });
    expect(app.callServerTool).toHaveBeenCalledWith({ name: 'frontier_delete_task', arguments: { task_id: 't1' } });
    app.callServerTool.mockResolvedValueOnce({ structuredContent: { task_id: 't1', accepted: false, reason: 'Stop the task first.' } });
    expect(await b.deleteTask('t1')).toEqual({ kind: 'refused', reason: 'Stop the task first.' });
    // Deleted elsewhere already: gone either way, so it counts as deleted (no error for the user).
    app.callServerTool.mockResolvedValueOnce({ isError: true, structuredContent: { error: { code: 'task_not_found', message: 'No such task.' } } });
    expect(await b.deleteTask('t1')).toEqual({ kind: 'deleted' });
    app.callServerTool.mockResolvedValueOnce({ isError: true, structuredContent: { error: { code: 'payment_required', message: 'Your plan is inactive.' } } });
    expect(await b.deleteTask('t1')).toEqual({ kind: 'failed', message: 'Your plan is inactive.' });
    app.callServerTool.mockRejectedValueOnce(new Error('timeout'));
    expect(await b.deleteTask('t1')).toEqual({ kind: 'failed', message: DELETE_FAILED });
    expect(app.callServerTool).toHaveBeenCalledTimes(5);
  });

  it('downloads through ui/download-file only when the host offers it', async () => {
    const downloadFile = vi.fn().mockResolvedValue({});
    const off = createHostBridge(fake({ getHostCapabilities: vi.fn(() => ({})), downloadFile }));
    expect(await off.downloadFile!('a.csv', 'text/csv', 'YSxi')).toBe(false);
    expect(downloadFile).not.toHaveBeenCalled();

    const on = createHostBridge(fake({ getHostCapabilities: vi.fn(() => ({ downloadFile: {} })), downloadFile }));
    expect(await on.downloadFile!('my list.csv', 'text/csv', 'YSxi')).toBe(true);
    expect(downloadFile).toHaveBeenCalledWith({
      contents: [{ type: 'resource', resource: { uri: 'file:///my%20list.csv', mimeType: 'text/csv', blob: 'YSxi' } }],
    });

    downloadFile.mockResolvedValueOnce({ isError: true });
    expect(await on.downloadFile!('a.csv', 'text/csv', 'YSxi')).toBe(false);
    downloadFile.mockRejectedValueOnce(new Error('gone'));
    expect(await on.downloadFile!('a.csv', 'text/csv', 'YSxi')).toBe(false);
  });
});

describe('task list full view calls (spec 2026-11-07)', () => {
  const notFound = { isError: true, structuredContent: { error: { code: 'task_not_found', message: 'Gone' } }, content: [{ type: 'text', text: 'Gone' }] };

  it('listTasks sends a title query only when there is one', async () => {
    const app = fake();
    app.callServerTool.mockResolvedValue({ structuredContent: { view: 'list', items: [], filters: { days: 7, query: 'memo' } } });
    const b = createHostBridge(app);
    await b.listTasks({ days: 7, query: 'memo' });
    await b.listTasks({ days: 7, query: null });
    expect(app.callServerTool.mock.calls.map((c) => c[0].arguments)).toEqual([{ days: 7, query: 'memo' }, { days: 7 }]);
  });

  it('checkTask says deleted only for task_not_found', async () => {
    const app = fake();
    const b = createHostBridge(app);
    app.callServerTool.mockResolvedValueOnce({ structuredContent: payload });
    expect(await b.checkTask!('t')).toBe('ok');
    app.callServerTool.mockResolvedValueOnce(notFound);
    expect(await b.checkTask!('t')).toBe('deleted');
    app.callServerTool.mockResolvedValueOnce({ isError: true, structuredContent: { error: { code: 'engine_unavailable' } } });
    expect(await b.checkTask!('t')).toBe('unknown');
    app.callServerTool.mockRejectedValueOnce(new Error('x'));
    expect(await b.checkTask!('t')).toBe('unknown');
  });

  it('a file link for a task that no longer exists is marked gone', async () => {
    const app = fake();
    app.callServerTool.mockResolvedValueOnce(notFound);
    const r = await createHostBridge(app).fileLink('t', null);
    expect(r).toMatchObject({ kind: 'failed', gone: true });
  });
});


describe('the prompt key (spec 2026-11-07 review)', () => {
  const access = { url: 'https://api.example.com/v1/runs/t/prompt', token: 'pk' };

  it('comes from _meta only, on host results and on getTask', async () => {
    const app = fake();
    const b = createHostBridge(app);
    const got: TaskPayload[] = [];
    b.onPayload((p) => got.push(p));
    app.ontoolresult({ structuredContent: { ...payload, prompt_access: { url: 'https://evil.example/prompt', token: 'x' } } });
    app.ontoolresult({ structuredContent: payload, _meta: { 'frontier/prompt': access } });
    expect(got.map((p) => p.prompt_access)).toEqual([null, access]);
    app.callServerTool.mockResolvedValue({ structuredContent: payload, _meta: { 'frontier/prompt': access } });
    expect((await b.getTask('t', 0))!.prompt_access).toEqual(access);
  });

  it('refuses anything but an https /prompt URL with a token', () => {
    expect(promptAccessOf({ _meta: { 'frontier/prompt': { url: 'http://api.example.com/v1/runs/t/prompt', token: 'pk' } } })).toBeNull();
    expect(promptAccessOf({ _meta: { 'frontier/prompt': { url: 'https://api.example.com/v1/runs/t/view', token: 'pk' } } })).toBeNull();
    expect(promptAccessOf({ _meta: { 'frontier/prompt': { url: access.url, token: 3 } } })).toBeNull();
    expect(promptAccessOf({})).toBeNull();
  });
});
