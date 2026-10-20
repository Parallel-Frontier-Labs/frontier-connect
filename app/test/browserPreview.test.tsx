import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserFrame, FeedStatus } from '../src/browserFeed';
import { Card } from '../src/view/Card';
import { BrowserPreview, canvasSize, FULLSCREEN_REFUSED, MAX_CANVAS_EDGE, type BrowserApi, type FeedHandle } from '../src/view/BrowserPreview';
import type { TaskPayload } from '../src/types';

const mk = (o: Partial<TaskPayload> = {}): TaskPayload => ({
  task_id: 't', status: 'running', title: 'Console check', plan: [], sections: [], live: null, estimate: null,
  open_ask: null, deliverables: [], result: null, work_ms: 0, usage: null, events: [], cursor: 0, more: false,
  browser: { state: 'live', site: 'app.example.com' }, ...o,
});
const fr = (seq: number, o: Partial<BrowserFrame> = {}): BrowserFrame =>
  ({ seq, awaiting: false, site: 'app.example.com', w: 1280, h: 800, data: 'AAAA', at: seq, ...o });

function api(...args: [string[] | undefined, string?] | []) {
  const modes = args.length ? args[0] : ['inline', 'fullscreen'];
  const mode = args[1] ?? 'inline';
  let push: (f: BrowserFrame | null) => void = () => {};
  let status: (s: FeedStatus) => void = () => {};
  const handle: FeedHandle = { start: vi.fn(), stop: vi.fn(), setMode: vi.fn(), setVisible: vi.fn(), wake: vi.fn() };
  const a: BrowserApi = {
    modes,
    mode,
    feed: vi.fn((onFrame, onStatus) => { push = onFrame; status = onStatus ?? (() => {}); return handle; }),
    requestDisplayMode: vi.fn(async () => 'fullscreen'),
  };
  return { api: a, handle, push: (f: BrowserFrame | null) => push(f), status: (st: FeedStatus) => status(st), disable: () => status('disabled') };
}

const draw = vi.fn();
beforeEach(() => {
  draw.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: draw }) as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('preview gating in the card', () => {
  it('shows the live preview while running with a live browser', () => {
    const a = api();
    const { getByRole, getByText, container } = render(<Card payload={mk()} browser={a.api} />);
    const region = getByRole('region', { name: 'Browser, live' });
    // No picture yet: the header says Connecting until a frame is on screen.
    expect(region.querySelector('.fc-bv-live')!.textContent).toBe('Connecting');
    expect(region.querySelector('.fc-bv-site')!.textContent).toBe('app.example.com');
    getByText('Watch only while the agent drives.');
    expect(container.querySelector('canvas')).not.toBeNull();
    expect(a.handle.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['waiting browser', { browser: { state: 'waiting', site: 'a.io' } }],
    ['ended browser', { browser: { state: 'ended', site: 'a.io' } }],
    ['no browser', { browser: null }],
    ['browser unknown', { browser: undefined }],
    ['starting', { status: 'starting' }],
    ['waiting for you', { status: 'waiting_for_you' }],
    ['done', { status: 'done' }],
  ] as const)('no preview: %s', (_n, o) => {
    const { queryByRole } = render(<Card payload={mk(o as Partial<TaskPayload>)} browser={api().api} />);
    expect(queryByRole('region', { name: 'Browser, live' })).toBeNull();
  });

  it('no preview without a browser api (hosts and tests that do not pass one)', () => {
    const { queryByRole } = render(<Card payload={mk()} />);
    expect(queryByRole('region', { name: 'Browser, live' })).toBeNull();
  });

  it('shows with a plan too, below the steps', () => {
    const plan = [{ title: 'Open the console', status: 'in_progress' as const }];
    const { container } = render(<Card payload={mk({ plan })} browser={api().api} />);
    const all = Array.from(container.querySelectorAll('.fc-timeline, .fc-bv'));
    expect(all.map((e) => e.className.split(' ')[0])).toEqual(['fc-timeline', 'fc-bv']);
  });

  it('stops the feed when the preview goes away', () => {
    const a = api();
    const { rerender } = render(<Card payload={mk()} browser={a.api} />);
    rerender(<Card payload={mk({ browser: { state: 'waiting', site: null } })} browser={a.api} />);
    expect(a.handle.stop).toHaveBeenCalledTimes(1);
  });
});

describe('full screen button', () => {
  it('shows only when the host offers fullscreen, and asks the host for it', async () => {
    const a = api(['inline', 'fullscreen']);
    const { getByRole } = render(<BrowserPreview site="app.example.com" api={a.api} />);
    const btn = getByRole('button', { name: 'Open the browser full screen' });
    expect(btn.textContent).toBe('Full screen');
    await act(async () => { fireEvent.click(btn); });
    expect(a.api.requestDisplayMode).toHaveBeenCalledWith('fullscreen');
  });

  it('reads the host answer: a refusal says so', async () => {
    const a = api(['inline', 'fullscreen']);
    (a.api.requestDisplayMode as ReturnType<typeof vi.fn>).mockResolvedValue('inline');
    const { getByRole, getByText } = render(<BrowserPreview site="a.io" api={a.api} />);
    await act(async () => { fireEvent.click(getByRole('button', { name: 'Open the browser full screen' })); });
    expect(getByText(FULLSCREEN_REFUSED).getAttribute('role')).toBe('status');
  });

  it('a granted request shows no note', async () => {
    const a = api(['inline', 'fullscreen']);
    const { getByRole, queryByText } = render(<BrowserPreview site="a.io" api={a.api} />);
    await act(async () => { fireEvent.click(getByRole('button', { name: 'Open the browser full screen' })); });
    expect(queryByText(FULLSCREEN_REFUSED)).toBeNull();
  });

  it('is hidden while the card is already full screen', () => {
    const { queryByRole } = render(<BrowserPreview site="a.io" api={api(['inline', 'fullscreen'], 'fullscreen').api} />);
    expect(queryByRole('button', { name: 'Open the browser full screen' })).toBeNull();
  });

  it.each([[undefined], [['inline']], [['inline', 'pip']], [[]]])('hidden for modes %j', (modes) => {
    const { queryByRole } = render(<BrowserPreview site="a.io" api={api(modes as string[] | undefined).api} />);
    expect(queryByRole('button', { name: 'Open the browser full screen' })).toBeNull();
  });
});

describe('painting frames', () => {
  it('paints each frame on the canvas at the frame size (createImageBitmap path)', async () => {
    const bitmaps: { w: number; close: () => void }[] = [];
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { const b = { w: bitmaps.length, close: vi.fn() }; bitmaps.push(b); return b; }));
    const a = api();
    const { container } = render(<BrowserPreview site="a.io" api={a.api} />);
    await act(async () => { a.push(fr(1, { w: 640, h: 400 })); await Promise.resolve(); await Promise.resolve(); });
    const canvas = container.querySelector('canvas')!;
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(400);
    expect(draw).toHaveBeenCalledWith(bitmaps[0], 0, 0, 640, 400);
    expect(bitmaps[0]!.close).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.fc-bv-live')!.textContent).toBe('Live');
    // The frame's own site is fresher than the payload's: it names the picture and the bar.
    expect(canvas.getAttribute('aria-label')).toBe('Live view of the task’s browser on app.example.com');
    expect(container.querySelector('.fc-bv-site')!.textContent).toBe('app.example.com');
  });

  it('drops a frame that finishes decoding after a newer one', async () => {
    const pending: ((b: unknown) => void)[] = [];
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise((res) => pending.push(res))));
    const a = api();
    render(<BrowserPreview site="a.io" api={a.api} />);
    const older = { id: 'older', close: vi.fn() };
    const newer = { id: 'newer', close: vi.fn() };
    await act(async () => {
      a.push(fr(1));
      a.push(fr(2));
      pending[1]!(newer);
      await Promise.resolve();
      pending[0]!(older);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw.mock.calls[0]![0]).toBe(newer);
    expect(older.close).toHaveBeenCalled();
  });

  it('falls back to an Image with a data url when createImageBitmap is missing', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const a = api();
    const { container } = render(<BrowserPreview site="a.io" api={a.api} />);
    const imgs: HTMLImageElement[] = [];
    const Orig = window.Image;
    vi.stubGlobal('Image', class extends Orig { constructor() { super(); imgs.push(this); } });
    await act(async () => { a.push(fr(1, { data: 'QUJD' })); });
    expect(imgs[0]!.src).toBe('data:image/jpeg;base64,QUJD');
    await act(async () => { imgs[0]!.onload?.(new Event('load')); });
    expect(draw).toHaveBeenCalledWith(imgs[0], 0, 0, 1280, 800);
    expect(container.querySelector('canvas')!.width).toBe(1280);
  });

  it('shows a waiting note until the first frame, and again on an empty (204) frame', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
    const a = api();
    const { container } = render(<BrowserPreview site="a.io" api={a.api} />);
    expect(container.querySelector('.fc-bv-wait')!.textContent).toBe('Waiting for the browser…');
    await act(async () => { a.push(fr(1)); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('.fc-bv-wait')).toBeNull();
    await act(async () => { a.push(null); });
    expect(container.querySelector('.fc-bv-wait')).not.toBeNull();
    expect(container.querySelector('.fc-bv-live')!.textContent).toBe('Connecting');
  });

  it('says so when this app cannot show the preview, and recovers when frames come back', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
    const a = api();
    const { container } = render(<BrowserPreview site="a.io" api={a.api} />);
    await act(async () => { a.status('unavailable'); });
    expect(container.querySelector('.fc-bv-wait')!.textContent).toBe('The live preview is not available in this app.');
    expect(container.querySelector('.fc-bv-live')!.textContent).toBe('Paused');
    await act(async () => { a.status('ok'); a.push(fr(1)); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('.fc-bv-wait')).toBeNull();
    expect(container.querySelector('.fc-bv-live')!.textContent).toBe('Live');
    await act(async () => { a.disable(); });
    expect(container.querySelector('.fc-bv-live')!.textContent).toBe('Paused');
  });

  it('skips a frame whose base64 does not decode, without throwing into the feed', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
    const a = api();
    render(<BrowserPreview site="a.io" api={a.api} />);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    await act(async () => {
      expect(() => a.push(fr(1, { data: 'A' }))).not.toThrow();
      await new Promise((r) => setTimeout(r, 0));
    });
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(draw).not.toHaveBeenCalled();
  });

  it('closes the bitmap even when drawing throws', async () => {
    const bmp = { close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bmp));
    draw.mockImplementation(() => { throw new Error('lost context'); });
    const a = api();
    render(<BrowserPreview site="a.io" api={a.api} />);
    await act(async () => { a.push(fr(1)); await Promise.resolve(); await Promise.resolve(); });
    expect(bmp.close).toHaveBeenCalledTimes(1);
  });

  it('unmounting during a decode paints nothing and closes the bitmap', async () => {
    let resolve!: (b: unknown) => void;
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise((res) => (resolve = res))));
    const a = api();
    const { unmount } = render(<BrowserPreview site="a.io" api={a.api} />);
    act(() => a.push(fr(1)));
    unmount();
    const bmp = { close: vi.fn() };
    await act(async () => { resolve(bmp); await Promise.resolve(); await Promise.resolve(); });
    expect(draw).not.toHaveBeenCalled();
    expect(bmp.close).toHaveBeenCalledTimes(1);
  });

  it('caps the canvas at 2048 px on the long edge, keeping the aspect', async () => {
    expect(MAX_CANVAS_EDGE).toBe(2048);
    expect(canvasSize(8192, 4096)).toEqual({ w: 2048, h: 1024 });
    expect(canvasSize(1000, 5000)).toEqual({ w: 410, h: 2048 });
    expect(canvasSize(1280, 800)).toEqual({ w: 1280, h: 800 });
    const bmp = { close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bmp));
    const a = api();
    const { container } = render(<BrowserPreview site="a.io" api={a.api} />);
    await act(async () => { a.push(fr(1, { w: 8000, h: 5000 })); await Promise.resolve(); await Promise.resolve(); });
    const c = container.querySelector('canvas')!;
    expect([c.width, c.height]).toEqual([2048, 1280]);
    expect(draw).toHaveBeenCalledWith(bmp, 0, 0, 2048, 1280);
  });

  it('pauses when scrolled out of view (IntersectionObserver) and wakes on visibility change', async () => {
    let cb: (e: { isIntersecting: boolean }[]) => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class { constructor(f: typeof cb) { cb = f; } observe() {} disconnect() { disconnect(); } });
    const a = api();
    const { unmount } = render(<BrowserPreview site="a.io" api={a.api} />);
    cb([{ isIntersecting: false }]);
    expect(a.handle.setVisible).toHaveBeenLastCalledWith(false);
    cb([{ isIntersecting: true }]);
    expect(a.handle.setVisible).toHaveBeenLastCalledWith(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(a.handle.wake).toHaveBeenCalled();
    unmount();
    expect(disconnect).toHaveBeenCalled();
    expect(a.handle.stop).toHaveBeenCalled();
    (a.handle.wake as ReturnType<typeof vi.fn>).mockClear();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(a.handle.wake).not.toHaveBeenCalled();
  });

  it('adds no keyboard listeners to the window or document', () => {
    const w = vi.spyOn(window, 'addEventListener');
    const d = vi.spyOn(document, 'addEventListener');
    render(<BrowserPreview site="a.io" api={api().api} />);
    const types = [...w.mock.calls, ...d.mock.calls].map((c) => c[0]);
    expect(types.filter((t) => /^key/.test(String(t)))).toEqual([]);
  });
});
