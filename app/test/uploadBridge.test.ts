import { describe, expect, it, vi } from 'vitest';
import { createHostBridge } from '../src/hostBridge';
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
});
