import { describe, expect, it, vi } from 'vitest';
import { CONTEXT_WAIT_MS, createHostBridge } from '../src/hostBridge';
import { parseAddFiles } from '../src/upload/addFiles';

function fakeApp(over: Record<string, unknown> = {}) {
  const app: any = {
    connect: vi.fn(async () => {}),
    getHostContext: () => ({}),
    getHostCapabilities: () => ({ serverTools: {}, message: {} }),
    callServerTool: vi.fn(async () => ({ structuredContent: { task_id: 't1', ticket_url: 'https://api.example.com/v1/connect/t#' + 'A'.repeat(43), expires_in_s: 600 } })),
    sendMessage: vi.fn(async () => ({})),
    ...over,
  };
  return app;
}

describe('parseAddFiles', () => {
  it('accepts the add_files view and caps the instruction', () => {
    expect(parseAddFiles({ view: 'add_files', task_id: 'task-1', instruction: 'x'.repeat(900) }))
      .toEqual({ view: 'add_files', task_id: 'task-1', instruction: 'x'.repeat(600), existing: false });
    expect(parseAddFiles({ view: 'add_files', task_id: 't', instruction: '', existing: true })?.existing).toBe(true);
    for (const bad of [null, {}, { view: 'list' }, { view: 'add_files', task_id: '' }, { view: 'add_files', task_id: 'x'.repeat(201) }]) {
      expect(parseAddFiles(bad)).toBeNull();
    }
  });
});

describe('host bridge uploads', () => {
  it('delivers an add_files tool result to onAddFiles, and replays the latest one', () => {
    const app = fakeApp();
    const b = createHostBridge(app);
    app.ontoolresult({ structuredContent: { view: 'add_files', task_id: 'task-1', instruction: 'Map it' } });
    const seen: string[] = [];
    b.onAddFiles!((a) => seen.push(a.task_id));
    expect(seen).toEqual(['task-1']);
  });

  it('gets a ticket through frontier_request_upload with the task and instruction', async () => {
    const app = fakeApp();
    const r = await createHostBridge(app).uploadTicket!('t1', 'Map it');
    expect(app.callServerTool).toHaveBeenCalledWith({ name: 'frontier_request_upload', arguments: { task_id: 't1', instruction: 'Map it' } });
    expect(r).toEqual({ kind: 'ok', url: 'https://api.example.com/v1/connect/t#' + 'A'.repeat(43) });
  });

  it('reports a refused ticket with the server\'s message', async () => {
    const app = fakeApp({ callServerTool: vi.fn(async () => ({ isError: true, structuredContent: { error: { message: 'Upload limit reached.' } } })) });
    expect(await createHostBridge(app).uploadTicket!('t1')).toEqual({ kind: 'failed', message: 'Upload limit reached.' });
  });

  it('posts a user message to the chat, false when the host cannot', async () => {
    const app = fakeApp();
    expect(await createHostBridge(app).sendMessage!('Files ready')).toBe(true);
    expect(app.sendMessage).toHaveBeenCalledWith({ role: 'user', content: [{ type: 'text', text: 'Files ready' }] });
    const none = fakeApp({ getHostCapabilities: () => ({ serverTools: {} }) });
    expect(await createHostBridge(none).sendMessage!('x')).toBe(false);
    const err = fakeApp({ sendMessage: vi.fn(async () => ({ isError: true })) });
    expect(await createHostBridge(err).sendMessage!('x')).toBe(false);
  });

  // PFL-84: Claude never received the card's "files are ready" message, so a task whose PDF had
  // arrived never started. The card also leaves the same text in the model's context.
  it('also leaves the text in the model context when the host offers it', async () => {
    const updateModelContext = vi.fn(async () => ({}));
    const app = fakeApp({ updateModelContext, getHostCapabilities: () => ({ serverTools: {}, message: {}, updateModelContext: {} }) });
    expect(await createHostBridge(app).sendMessage!('Files ready')).toBe(true);
    expect(updateModelContext).toHaveBeenCalledWith({ content: [{ type: 'text', text: 'Files ready' }] });
  });

  it('a host with model context but no messages still gets the context, and the card says so', async () => {
    const updateModelContext = vi.fn(async () => ({}));
    const sendMessage = vi.fn(async () => ({}));
    const app = fakeApp({ updateModelContext, sendMessage, getHostCapabilities: () => ({ serverTools: {}, updateModelContext: {} }) });
    expect(await createHostBridge(app).sendMessage!('Files ready')).toBe(false);
    expect(updateModelContext).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a refused or throwing model-context update never blocks the message', async () => {
    const updateModelContext = vi.fn(async () => { throw new Error('no'); });
    const app = fakeApp({ updateModelContext, getHostCapabilities: () => ({ serverTools: {}, message: {}, updateModelContext: {} }) });
    expect(await createHostBridge(app).sendMessage!('Files ready')).toBe(true);
    expect(app.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('a model-context update the host never answers does not hold the message back', async () => {
    vi.useFakeTimers();
    try {
      const updateModelContext = vi.fn(() => new Promise(() => {})); // never settles
      const app = fakeApp({ updateModelContext, getHostCapabilities: () => ({ serverTools: {}, message: {}, updateModelContext: {} }) });
      const sent = createHostBridge(app).sendMessage!('Files ready');
      await vi.advanceTimersByTimeAsync(CONTEXT_WAIT_MS);
      expect(app.sendMessage).toHaveBeenCalledTimes(1);
      expect(await sent).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never calls updateModelContext when the host does not offer it', async () => {
    const updateModelContext = vi.fn(async () => ({}));
    const app = fakeApp({ updateModelContext });
    await createHostBridge(app).sendMessage!('x');
    expect(updateModelContext).not.toHaveBeenCalled();
  });
});
