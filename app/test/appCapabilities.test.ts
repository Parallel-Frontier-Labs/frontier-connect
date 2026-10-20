import { describe, expect, it, vi } from 'vitest';

const ctor = vi.fn();
vi.mock('@modelcontextprotocol/ext-apps', () => ({
  App: class {
    constructor(...a: unknown[]) { ctor(...a); }
    connect() { return Promise.resolve(); }
    getHostContext() { return undefined; }
  },
}));

describe('default App', () => {
  it('is created with the card capabilities (inline and fullscreen display modes)', async () => {
    const { createHostBridge, appCapabilities } = await import('../src/hostBridge');
    createHostBridge();
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor.mock.calls[0]![1]).toBe(appCapabilities);
    expect(ctor.mock.calls[0]![1]).toEqual({ availableDisplayModes: ['inline', 'fullscreen'] });
    expect(ctor.mock.calls[0]![2]).toEqual({ autoResize: true });
  });
});
