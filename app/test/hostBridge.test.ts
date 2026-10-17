import { describe, expect, it, vi } from 'vitest';
import type { App } from '@modelcontextprotocol/ext-apps';
import { createHostBridge } from '../src/hostBridge';
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
});
