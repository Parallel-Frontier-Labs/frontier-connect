import { describe, expect, it, vi } from 'vitest';
import type { App } from '@modelcontextprotocol/ext-apps';
import { createHostBridge } from '../src/hostBridge';

/** A scripted host: a context the test changes, a display-mode answer the test chooses. */
function host(ctx: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  let context: Record<string, unknown> | undefined = ctx;
  const app: Record<string, unknown> = {
    connect: vi.fn().mockResolvedValue(undefined),
    callServerTool: vi.fn(),
    getHostContext: vi.fn(() => context),
    getHostVersion: vi.fn(() => ({ name: 'Codex', version: '1.2.3' })),
    requestDisplayMode: vi.fn(async ({ mode }: { mode: string }) => ({ mode })),
    ...over,
  };
  const fire = (p: Record<string, unknown>) => {
    context = { ...context, ...p };
    (app as { onhostcontextchanged: (p: unknown) => void }).onhostcontextchanged(p);
  };
  return { app: app as unknown as App, raw: app, fire, set: (c: Record<string, unknown> | undefined) => (context = c) };
}

describe('bridge display modes', () => {
  it('displayModes() reads availableDisplayModes, or undefined when the host does not say', () => {
    const h = host({ availableDisplayModes: ['inline', 'fullscreen'] });
    const b = createHostBridge(h.app);
    expect(b.displayModes!()).toEqual(['inline', 'fullscreen']);
    h.set({});
    expect(b.displayModes!()).toBeUndefined();
    h.set({ availableDisplayModes: ['inline', 7, 'fullscreen', '__proto__x'.repeat(10)] });
    expect(b.displayModes!()).toEqual(['inline', 'fullscreen']);
  });

  it('displayMode() is the host mode, inline when unknown', () => {
    const h = host({});
    const b = createHostBridge(h.app);
    expect(b.displayMode!()).toBe('inline');
    h.set({ displayMode: 'pip' });
    expect(b.displayMode!()).toBe('pip');
  });

  it('requestDisplayMode resolves with the mode the host applied, not the one asked for', async () => {
    const h = host({ displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] }, {
      requestDisplayMode: vi.fn(async () => ({ mode: 'inline' })),
    });
    const b = createHostBridge(h.app);
    expect(await b.requestDisplayMode!('fullscreen')).toBe('inline');
    expect(h.raw.requestDisplayMode).toHaveBeenCalledWith({ mode: 'fullscreen' });
  });

  it('requestDisplayMode: a granted mode is reported and fires the change listeners once', async () => {
    const h = host({ displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] });
    const b = createHostBridge(h.app);
    const modes: string[] = [];
    const frames: boolean[] = [];
    b.onDisplayModeChange!((m) => modes.push(m));
    b.onEmbeddedChange!((e) => frames.push(e));
    expect(await b.requestDisplayMode!('fullscreen')).toBe('fullscreen');
    expect(b.displayMode!()).toBe('fullscreen');
    expect(b.embedded!()).toBe(false);
    // The host also sends the context change: no second notification for the same mode.
    h.fire({ displayMode: 'fullscreen' });
    expect(modes).toEqual(['fullscreen']);
    expect(frames).toEqual([false]);
    h.fire({ displayMode: 'inline' });
    expect(modes).toEqual(['fullscreen', 'inline']);
    expect(b.displayMode!()).toBe('inline');
  });

  it('requestDisplayMode keeps the current mode when the host rejects, errs or has no support', async () => {
    const rejecting = host({ displayMode: 'inline' }, { requestDisplayMode: vi.fn().mockRejectedValue(new Error('no')) });
    expect(await createHostBridge(rejecting.app).requestDisplayMode!('fullscreen')).toBe('inline');
    const garbage = host({ displayMode: 'pip' }, { requestDisplayMode: vi.fn(async () => ({ mode: 'theater' })) });
    expect(await createHostBridge(garbage.app).requestDisplayMode!('fullscreen')).toBe('pip');
    const none = host({}, { requestDisplayMode: undefined });
    expect(await createHostBridge(none.app).requestDisplayMode!('fullscreen')).toBe('inline');
  });

  it('onDisplayModeChange also fires when the available modes change', () => {
    const h = host({ displayMode: 'inline' });
    const b = createHostBridge(h.app);
    const seen: string[] = [];
    b.onDisplayModeChange!((m) => seen.push(m));
    h.fire({ availableDisplayModes: ['inline', 'fullscreen'] });
    h.fire({ theme: 'dark' });
    expect(seen).toEqual(['inline']);
    expect(b.displayModes!()).toEqual(['inline', 'fullscreen']);
  });

  it('hostInfo() reports host name/version, platform, modes and container only', () => {
    const h = host({
      platform: 'desktop', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'],
      containerDimensions: { width: 720, maxHeight: 900 }, userAgent: 'secret-ish', locale: 'en-US', timeZone: 'Europe/Paris',
      theme: 'dark', toolInfo: { id: 1, tool: { name: 'x' } },
    });
    const info = createHostBridge(h.app).hostInfo!();
    expect(info).toEqual({
      host: { name: 'Codex', version: '1.2.3' }, platform: 'desktop', displayMode: 'inline',
      displayModes: ['inline', 'fullscreen'], container: { width: 720, maxHeight: 900 },
    });
  });

  it('hostInfo() caps strings and drops junk', () => {
    const h = host(
      { platform: 'toaster', containerDimensions: { width: Infinity, height: -1, maxWidth: 'wide' } },
      { getHostVersion: vi.fn(() => ({ name: 'n'.repeat(500), version: 3 })) },
    );
    const info = createHostBridge(h.app).hostInfo!();
    expect(info.host).toEqual({ name: 'n'.repeat(64) });
    expect(info.platform).toBeUndefined();
    expect(info.container).toBeUndefined();
    expect(createHostBridge(host(undefined as unknown as Record<string, unknown>, { getHostVersion: undefined }).app).hostInfo!()).toEqual({ displayMode: 'inline' });
  });

  it('declares inline and fullscreen as the modes the card supports', async () => {
    const { appCapabilities } = await import('../src/hostBridge');
    expect(appCapabilities.availableDisplayModes).toEqual(['inline', 'fullscreen']);
  });

  it('stopTask calls frontier_stop_task and reports whether it was taken', async () => {
    const h = host({});
    const call = h.raw.callServerTool as ReturnType<typeof vi.fn>;
    const b = createHostBridge(h.app);
    call.mockResolvedValueOnce({ structuredContent: { task_id: 't', status: 'stopping' } });
    expect(await b.stopTask!('t')).toBe(true);
    expect(call).toHaveBeenCalledWith({ name: 'frontier_stop_task', arguments: { task_id: 't' } });
    call.mockResolvedValueOnce({ isError: true });
    expect(await b.stopTask!('t')).toBe(false);
    call.mockRejectedValueOnce(new Error('no'));
    expect(await b.stopTask!('t')).toBe(false);
  });
});

