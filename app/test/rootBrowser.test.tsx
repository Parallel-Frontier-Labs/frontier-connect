import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bridge } from '../src/bridge';
import { Root } from '../src/Root';
import type { TaskPayload } from '../src/types';

const VIEW = 'https://api.example.com/v1/runs/t1/view';
const running = {
  task_id: 't1', status: 'running', title: 'Console check', plan: [], sections: [], live: null,
  estimate: null, open_ask: null, deliverables: [], result: null, work_ms: 0, usage: null,
  events: [], cursor: 1, more: false, view: { token: 'tok', expires_in_s: 1800, url: VIEW },
  browser: { state: 'live', site: 'app.example.com' },
} as unknown as TaskPayload;

function rig(extra: Partial<Bridge> = {}) {
  let onPayload: (p: TaskPayload) => void = () => {};
  let onReady: () => void = () => {};
  let onMode: (m: string) => void = () => {};
  let modes: string[] | undefined = ['inline', 'fullscreen'];
  let mode = 'inline';
  const bridge: Bridge = {
    onPayload: (cb) => (onPayload = cb),
    getTask: async () => null,
    theme: () => 'light',
    onThemeChange: () => {},
    onConnectError: () => {},
    canCallTools: () => false,
    onReady: (cb) => (onReady = cb),
    answer: async () => ({ kind: 'failed', message: '' }),
    onList: () => {},
    listTasks: async () => ({ kind: 'failed', message: '' }),
    deleteTask: async () => ({ kind: 'failed', message: '' }),
    fileLink: async () => ({ kind: 'failed', message: '' }),
    openLink: async () => false,
    displayModes: () => modes,
    displayMode: () => mode,
    requestDisplayMode: vi.fn(async () => 'fullscreen'),
    onDisplayModeChange: (cb) => (onMode = cb),
    hostInfo: () => ({ host: { name: 'Codex', version: '1' }, platform: 'desktop', displayMode: 'inline', displayModes: modes }),
    ...extra,
  };
  return {
    bridge,
    payload: (p: TaskPayload) => onPayload(p),
    ready: () => onReady(),
    setModes: (m: string[] | undefined) => { modes = m; onMode(mode); },
    setMode: (m: string) => { mode = m; onMode(m); },
  };
}

const resp = (status: number) => ({ status, ok: status >= 200 && status < 300, json: async () => null }) as unknown as Response;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Root host report', () => {
  it('posts one host report per card mount, once the host is ready and a view token is known', async () => {
    const f = vi.fn(async (..._a: unknown[]) => resp(204));
    vi.stubGlobal('fetch', f);
    const r = rig();
    render(<Root makeBridge={() => r.bridge} />);
    const reports = () => f.mock.calls.filter((c) => String(c[0]).endsWith('/v1/connect/host-report'));
    act(() => r.payload(running));
    expect(reports()).toHaveLength(0); // not ready yet
    act(() => r.ready());
    expect(reports()).toHaveLength(1);
    expect(reports()[0]![0]).toBe('https://api.example.com/v1/connect/host-report');
    const init = reports()[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toMatchObject({ host: { name: 'Codex' }, platform: 'desktop' });
    act(() => r.payload({ ...running, cursor: 2 }));
    act(() => r.ready());
    expect(reports()).toHaveLength(1);
  });

  it('sends nothing without a view token or a hostInfo bridge', () => {
    const f = vi.fn(async (..._a: unknown[]) => resp(204));
    vi.stubGlobal('fetch', f);
    const r = rig({ hostInfo: undefined });
    render(<Root makeBridge={() => r.bridge} />);
    act(() => { r.ready(); r.payload(running); });
    const r2 = rig();
    render(<Root makeBridge={() => r2.bridge} />);
    act(() => { r2.ready(); r2.payload({ ...running, view: null }); });
    expect(f.mock.calls.filter((c) => String(c[0]).endsWith('/host-report'))).toHaveLength(0);
  });
});

describe('Root browser preview wiring', () => {
  it('shows the preview with Full screen when the host offers it, and asks the host for fullscreen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(204)));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    const r = rig();
    const { getByRole, queryByRole } = render(<Root makeBridge={() => r.bridge} />);
    act(() => { r.ready(); r.payload(running); });
    getByRole('region', { name: 'Browser, live' });
    await act(async () => { fireEvent.click(getByRole('button', { name: 'Open the browser full screen' })); });
    expect(r.bridge.requestDisplayMode).toHaveBeenCalledWith('fullscreen');
    act(() => r.setMode('fullscreen'));
    expect(queryByRole('button', { name: 'Open the browser full screen' })).toBeNull();
    act(() => r.setMode('inline'));
    getByRole('button', { name: 'Open the browser full screen' });
    act(() => r.setModes(['inline']));
    expect(queryByRole('button', { name: 'Open the browser full screen' })).toBeNull();
  });

  it('Stop task goes through the bridge when the host forwards the card tool calls, then reads the task', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(204)));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    const stopTask = vi.fn(async () => true);
    const waiting = { ...running, status: 'waiting_for_you', browser: { state: 'waiting', site: 'app.example.com' } } as unknown as TaskPayload;
    const r = rig({ stopTask, canCallTools: () => true });
    const { getByRole } = render(<Root makeBridge={() => r.bridge} />);
    act(() => { r.ready(); r.payload(waiting); });
    await act(async () => { fireEvent.click(getByRole('button', { name: 'Stop task' })); await Promise.resolve(); });
    expect(stopTask).toHaveBeenCalledWith('t1');
  });

  it('no Stop task when the host does not forward the card tool calls', () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(204)));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    const waiting = { ...running, status: 'waiting_for_you', browser: { state: 'waiting', site: 'app.example.com' } } as unknown as TaskPayload;
    const r = rig({ stopTask: vi.fn(async () => true), canCallTools: () => false });
    const { queryByRole, getByRole } = render(<Root makeBridge={() => r.bridge} />);
    act(() => { r.ready(); r.payload(waiting); });
    getByRole('button', { name: 'Take over' });
    expect(queryByRole('button', { name: 'Stop task' })).toBeNull();
  });

  it('once the host blocks the card own requests, Take over gives way to "open the task in Frontier"', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
        if (String(u).includes('/view')) throw new TypeError('blocked');
        return resp(204);
      }));
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
      const waiting = { ...running, status: 'waiting_for_you', browser: { state: 'waiting', site: 'app.example.com' } } as unknown as TaskPayload;
      const r = rig();
      const { queryByRole, getByText } = render(<Root makeBridge={() => r.bridge} />);
      act(() => { r.ready(); r.payload(waiting); });
      expect(queryByRole('button', { name: 'Take over' })).not.toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
      expect(queryByRole('button', { name: 'Take over' })).toBeNull();
      getByText(/can't control the task's browser/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a direct path that dropped after working shows Reconnecting, then Take over again when it is back', async () => {
    vi.useFakeTimers();
    try {
      let down = false;
      vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
        if (String(u).includes('/view')) {
          if (down) throw new TypeError('offline');
          return { status: 200, ok: true, json: async () => null } as unknown as Response;
        }
        return resp(204);
      }));
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
      const waiting = { ...running, status: 'waiting_for_you', browser: { state: 'waiting', site: 'app.example.com' } } as unknown as TaskPayload;
      const r = rig();
      const { getByRole, queryByText } = render(<Root makeBridge={() => r.bridge} />);
      act(() => { r.ready(); r.payload(waiting); });
      await act(async () => { await vi.advanceTimersByTimeAsync(5100); }); // a direct read works
      down = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(5100); }); // the next one fails
      expect((getByRole('button', { name: 'Take over' }) as HTMLButtonElement).disabled).toBe(true);
      getByRole('status');
      expect(queryByText(/can't control the task's browser/)).toBeNull();
      down = false;
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
      expect((getByRole('button', { name: 'Take over' }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

