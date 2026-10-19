import { describe, expect, it, vi } from 'vitest';
import type { App } from '@modelcontextprotocol/ext-apps';
import { createHostBridge, DELETE_FAILED, LIST_FAILED, SEND_FAILED } from '../src/hostBridge';
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

  it('theme maps the host context', () => {
    const app = fake();
    const b = createHostBridge(app);
    expect(b.theme()).toBe('dark');
    app.getHostContext.mockReturnValue({ theme: 'light' });
    expect(b.theme()).toBe('light');
    app.getHostContext.mockReturnValue(undefined);
    expect(b.theme()).toBe('light');
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
});
