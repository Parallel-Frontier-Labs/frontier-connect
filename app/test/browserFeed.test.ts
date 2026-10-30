import { describe, expect, it, vi } from 'vitest';
import type { HostInfo } from '../src/bridge';
import {
  BrowserFeed, controlUrl, inputUrl, postControl, postInput, FEED_BACKOFF_MS, FEED_INTERVAL_MS, FEED_RETRY_DIRECT_MS, FEED_TIMEOUT_MS, type FeedStatus, frameUrl, hostReportBody, hostReportUrl, sendHostReport,
  type BrowserFrame, type FrameSource,
} from '../src/browserFeed';

const VIEW = 'https://api.example.com/v1/runs/t-1/view';
const FRAME = 'https://api.example.com/v1/runs/t-1/browser/frame';
const resp = (status: number, body?: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const frame = (o: Record<string, unknown> = {}) => ({ awaiting: false, site: 'app.example.com', w: 1280, h: 800, data: 'AAAA', at: 5, ...o });
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

function rig(fetchImpl: (...a: unknown[]) => Promise<Response>, src: Partial<FrameSource> = {}) {
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let id = 0;
  let hidden = false;
  let token = 'tok';
  const source: FrameSource = {
    view: () => ({ token, url: VIEW, taskId: 't-1' }),
    renewToken: vi.fn(async () => { token = 'tok2'; return true; }),
    bridgeOnly: () => false,
    ...src,
  };
  const frames: (BrowserFrame | null)[] = [];
  const statuses: FeedStatus[] = [];
  const onDisabled = vi.fn();
  const f = vi.fn(fetchImpl);
  const feed = new BrowserFeed({
    source, onFrame: (x) => frames.push(x), onStatus: (st) => { statuses.push(st); if (st === 'disabled') onDisabled(); }, fetchImpl: f as unknown as typeof fetch, hidden: () => hidden,
    setTimer: (fn, ms) => { const h = { fn, ms, id: ++id }; timers.push(h); return h.id; },
    clearTimer: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
  });
  // The next scheduled tick (the per-request timeout timer is not a tick).
  const fire = async () => {
    const i = timers.findIndex((t) => t.ms !== FEED_TIMEOUT_MS);
    expect(i).toBeGreaterThanOrEqual(0);
    const [x] = timers.splice(i, 1);
    x!.fn();
    await flush();
  };
  const ticks = () => timers.filter((t) => t.ms !== FEED_TIMEOUT_MS);
  const timeout = () => timers.find((t) => t.ms === FEED_TIMEOUT_MS);
  return { feed, timers, ticks, timeout, frames, fire, fetch: f, source, onDisabled, statuses, setHidden: (h: boolean) => (hidden = h) };
}

describe('frame and host-report URLs', () => {
  it('derive from the view url, keeping the issuer and any path prefix', () => {
    expect(frameUrl(VIEW)).toBe(FRAME);
    expect(frameUrl('https://h.example.com/api/v1/runs/abc/view')).toBe('https://h.example.com/api/v1/runs/abc/browser/frame');
    expect(hostReportUrl(VIEW)).toBe('https://api.example.com/v1/connect/host-report');
    expect(inputUrl(VIEW)).toBe('https://api.example.com/v1/runs/t-1/browser/input');
  });
  it('controlUrl builds the route', () => {
    expect(controlUrl(VIEW)).toBe('https://api.example.com/v1/runs/t-1/browser/control');
    expect(controlUrl('https://h.example.com/api/v1/runs/abc/view')).toBe('https://h.example.com/api/v1/runs/abc/browser/control');
  });
  it('refuse anything that is not an https view url', () => {
    for (const u of ['http://api.example.com/v1/runs/t/view', 'https://a.io/v1/runs/t/other', 'javascript:alert(1)', 'nope', 'https://a.io/v1/runs//view', 'https://a.io/v1/runs/t/view?x=1']) {
      expect(frameUrl(u)).toBeNull();
      expect(hostReportUrl(u)).toBeNull();
      expect(inputUrl(u)).toBeNull();
      expect(controlUrl(u)).toBeNull();
    }
  });
});

describe('BrowserFeed', () => {
  it('polls the frame url with the view token every 500 ms in preview and 200 ms in control', async () => {
    const r = rig(async () => resp(200, frame()));
    r.feed.start();
    expect(r.timers[0]!.ms).toBe(0);
    await r.fire();
    expect(r.fetch).toHaveBeenCalledWith(FRAME, { headers: { Authorization: 'Bearer tok' }, signal: expect.any(AbortSignal) });
    expect(r.frames).toEqual([{ seq: 1, awaiting: false, site: 'app.example.com', w: 1280, h: 800, data: 'AAAA', at: 5 }]);
    expect(r.timers[0]!.ms).toBe(FEED_INTERVAL_MS.preview);
    expect(FEED_INTERVAL_MS).toEqual({ preview: 500, control: 200 });
    r.feed.setMode('control');
    expect(r.timers.map((t) => t.ms)).toEqual([200]);
    await r.fire();
    expect(r.timers[0]!.ms).toBe(200);
    expect(r.frames.map((x) => x?.seq)).toEqual([1, 2]);
  });

  it('204 reports no frame', async () => {
    const r = rig(async () => resp(204));
    r.feed.start();
    await r.fire();
    expect(r.frames).toEqual([null]);
    expect(r.timers[0]!.ms).toBe(500);
  });

  it('429 and 503 back off for 1 s', async () => {
    const r = rig(async () => resp(429));
    r.feed.start();
    await r.fire();
    expect(FEED_BACKOFF_MS).toBe(1000);
    expect(r.timers[0]!.ms).toBe(1000);
    expect(r.frames).toEqual([]);
    r.fetch.mockImplementation(async () => resp(503));
    await r.fire();
    expect(r.timers[0]!.ms).toBe(1000);
    r.fetch.mockImplementation(async () => { throw new TypeError('network'); });
    await r.fire();
    expect(r.timers[0]!.ms).toBe(1000);
  });

  it('401 asks the poller to renew the token, then uses the new one', async () => {
    const r = rig(async () => resp(401));
    r.feed.start();
    await r.fire();
    expect(r.source.renewToken).toHaveBeenCalledTimes(1);
    r.fetch.mockImplementation(async () => resp(200, frame()));
    await r.fire();
    expect(r.fetch).toHaveBeenLastCalledWith(FRAME, { headers: { Authorization: 'Bearer tok2' }, signal: expect.any(AbortSignal) });
    expect(r.frames).toHaveLength(1);
  });

  it('turns itself off after repeated token refusals', async () => {
    const r = rig(async () => resp(401), { renewToken: vi.fn(async () => false) });
    r.feed.start();
    for (let i = 0; i < 3; i++) await r.fire();
    expect(r.feed.disabled).toBe(true);
    expect(r.onDisabled).toHaveBeenCalledTimes(1);
    expect(r.timers).toHaveLength(0);
  });

  it('on a bridge-only transport it says unavailable and tries the direct path every 30 s', async () => {
    let bridge = true;
    const r = rig(async () => { throw new TypeError('blocked'); }, { bridgeOnly: () => bridge });
    r.feed.start();
    await r.fire();
    expect(r.fetch).not.toHaveBeenCalled();
    expect(r.statuses).toEqual(['unavailable']);
    expect(r.ticks().map((t) => t.ms)).toEqual([FEED_RETRY_DIRECT_MS]);
    expect(FEED_RETRY_DIRECT_MS).toBe(30_000);
    // Wake-ups do not shorten the wait.
    r.feed.setVisible(false);
    r.feed.setVisible(true);
    r.feed.wake();
    r.feed.setMode('control');
    expect(r.ticks().map((t) => t.ms)).toEqual([FEED_RETRY_DIRECT_MS]);
    await r.fire(); // the retry: still blocked
    expect(r.fetch).toHaveBeenCalledTimes(1);
    expect(r.ticks().map((t) => t.ms)).toEqual([FEED_RETRY_DIRECT_MS]);
    r.fetch.mockImplementation(async () => resp(200, frame()));
    await r.fire(); // the next retry answers: frames resume at the usual rate, still bridge-only
    expect(r.frames).toHaveLength(1);
    expect(r.statuses).toEqual(['unavailable', 'ok']);
    expect(r.ticks().map((t) => t.ms)).toEqual([200]);
    await r.fire();
    expect(r.frames).toHaveLength(2);
    r.fetch.mockImplementation(async () => resp(503));
    await r.fire(); // fails again: back to the 30 s retry
    expect(r.statuses).toEqual(['unavailable', 'ok', 'unavailable']);
    expect(r.ticks().map((t) => t.ms)).toEqual([FEED_RETRY_DIRECT_MS]);
    expect(r.feed.disabled).toBe(false);
    bridge = false;
  });

  it('is disabled when the view url is not one it recognises', async () => {
    const r = rig(async () => resp(200, frame()), { view: () => ({ token: 't', url: 'https://a.io/elsewhere', taskId: 't' }) });
    r.feed.start();
    if (r.timers.length) await r.fire();
    expect(r.fetch).not.toHaveBeenCalled();
    expect(r.feed.disabled).toBe(true);
  });

  it('waits while there is no view token yet', async () => {
    let view: ReturnType<FrameSource['view']> = null;
    const r = rig(async () => resp(204), { view: () => view });
    r.feed.start();
    await r.fire();
    expect(r.fetch).not.toHaveBeenCalled();
    expect(r.timers[0]!.ms).toBe(1000);
    view = { token: 'tok', url: VIEW, taskId: 't-1' };
    await r.fire();
    expect(r.fetch).toHaveBeenCalledTimes(1);
  });

  it('pauses while the document is hidden and resumes on wake()', async () => {
    const r = rig(async () => resp(204));
    r.feed.start();
    r.setHidden(true);
    await r.fire();
    expect(r.fetch).not.toHaveBeenCalled();
    expect(r.timers).toHaveLength(0);
    r.feed.wake(); // still hidden
    expect(r.timers).toHaveLength(0);
    r.setHidden(false);
    r.feed.wake();
    expect(r.timers.map((t) => t.ms)).toEqual([0]);
    await r.fire();
    expect(r.fetch).toHaveBeenCalledTimes(1);
  });

  it('pauses while the preview is out of view', async () => {
    const r = rig(async () => resp(204));
    r.feed.start();
    await r.fire();
    r.feed.setVisible(false);
    await r.fire();
    expect(r.fetch).toHaveBeenCalledTimes(1);
    expect(r.timers).toHaveLength(0);
    r.feed.setVisible(true);
    expect(r.timers.map((t) => t.ms)).toEqual([0]);
    await r.fire();
    expect(r.fetch).toHaveBeenCalledTimes(2);
  });

  it('never has more than one request in flight', async () => {
    let release!: (r: Response) => void;
    const r = rig(() => new Promise<Response>((res) => (release = res)));
    r.feed.start();
    r.timers.shift()!.fn();
    await flush();
    expect(r.fetch).toHaveBeenCalledTimes(1);
    r.feed.setVisible(false);
    r.feed.setVisible(true);
    r.feed.wake();
    r.feed.setMode('control');
    r.feed.start();
    expect(r.ticks()).toHaveLength(0);
    expect(r.fetch).toHaveBeenCalledTimes(1);
    release(resp(204));
    await flush();
    expect(r.timers.map((t) => t.ms)).toEqual([200]);
  });

  it('drops a response that lands after stop()', async () => {
    let release!: (r: Response) => void;
    const r = rig(() => new Promise<Response>((res) => (release = res)));
    r.feed.start();
    r.timers.shift()!.fn();
    await flush();
    r.feed.stop();
    release(resp(200, frame()));
    await flush();
    expect(r.frames).toEqual([]);
    expect(r.timers).toHaveLength(0);
  });

  it('aborts a request that hangs for 5 s and goes on', async () => {
    const signals: AbortSignal[] = [];
    const r = rig((_u, init) => new Promise<Response>((_res, rej) => {
      const sig = (init as RequestInit).signal!;
      signals.push(sig);
      sig.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    r.feed.start();
    await r.fire();
    expect(r.fetch).toHaveBeenCalledTimes(1);
    expect(FEED_TIMEOUT_MS).toBe(5000);
    expect(r.ticks()).toHaveLength(0); // still in flight
    const t = r.timeout()!;
    r.timers.splice(r.timers.indexOf(t), 1);
    t.fn();
    await flush();
    expect(signals[0]!.aborted).toBe(true);
    expect(r.ticks().map((x) => x.ms)).toEqual([FEED_BACKOFF_MS]);
    r.fetch.mockImplementation(async () => resp(204));
    await r.fire();
    expect(r.fetch).toHaveBeenCalledTimes(2);
    expect(r.frames).toEqual([null]);
  });

  it('aborts a frame whose body stalls past the 5 s deadline', async () => {
    let sig!: AbortSignal;
    const r = rig(async (_u, init) => {
      sig = (init as RequestInit).signal!;
      return { status: 200, ok: true, json: () => new Promise(() => {}) } as unknown as Response;
    });
    r.feed.start();
    await r.fire();
    expect(r.ticks()).toHaveLength(0); // the body is still being read: one request in flight
    const t = r.timeout()!;
    expect(t).toBeTruthy();
    r.timers.splice(r.timers.indexOf(t), 1);
    t.fn();
    await flush();
    expect(sig.aborted).toBe(true);
    expect(r.ticks().map((x) => x.ms)).toEqual([FEED_BACKOFF_MS]);
    expect(r.frames).toEqual([]);
  });

  it('stop() aborts the request in flight and clears its timeout', async () => {
    let sig!: AbortSignal;
    const r = rig((_u, init) => new Promise<Response>(() => { sig = (init as RequestInit).signal!; }));
    r.feed.start();
    await r.fire();
    r.feed.stop();
    expect(sig.aborted).toBe(true);
    await flush();
    expect(r.timers).toHaveLength(0);
  });

  it('a 401 for a token the Poller has since replaced is retried at once, not counted', async () => {
    let token = 'old';
    let release!: (r: Response) => void;
    const renew = vi.fn(async () => false);
    const r = rig(() => new Promise<Response>((res) => (release = res)), {
      view: () => ({ token, url: VIEW, taskId: 't-1' }), renewToken: renew,
    });
    r.feed.start();
    for (let i = 0; i < 4; i++) {
      await r.fire();
      token = `new${i}`; // refreshed while the request was in flight
      release(resp(401));
      await flush();
      expect(r.ticks().map((t) => t.ms)).toEqual([0]);
    }
    expect(renew).not.toHaveBeenCalled();
    expect(r.feed.disabled).toBe(false);
  });

  it('ignores a view for another task and drops a frame that lands after the task changed', async () => {
    let taskId = 't-1';
    let release!: (r: Response) => void;
    const r = rig(() => new Promise<Response>((res) => (release = res)), {
      view: () => ({ token: 'tok', url: VIEW, taskId }),
    });
    r.feed.start();
    await r.fire();
    taskId = 't-2';
    release(resp(200, frame()));
    await flush();
    expect(r.frames).toEqual([]);
    await r.fire();
    expect(r.fetch).toHaveBeenCalledTimes(1); // no request with the other task's token
    expect(r.ticks().map((t) => t.ms)).toEqual([FEED_BACKOFF_MS]);
  });

  it('ignores malformed frames', async () => {
    const bad = [
      null, 'x', frame({ w: 0 }), frame({ h: -3 }), frame({ w: 1.5 }), frame({ w: 99999 }), frame({ data: '' }),
      frame({ data: 'not base64!' }), frame({ data: 7 }),
    ];
    let i = 0;
    const r = rig(async () => resp(200, bad[i++]));
    r.feed.start();
    for (let k = 0; k < bad.length; k++) await r.fire();
    expect(r.frames).toEqual([]);
    r.fetch.mockImplementation(async () => resp(200, frame({ site: 'https://evil', awaiting: 'yes', at: 'later' })));
    await r.fire();
    expect(r.frames).toEqual([{ seq: 1, awaiting: false, site: null, w: 1280, h: 800, data: 'AAAA', at: 0 }]);
  });
});

describe('host report', () => {
  const info: HostInfo = {
    host: { name: 'Codex', version: '1.2.3' }, platform: 'desktop', displayMode: 'inline',
    displayModes: ['inline', 'fullscreen'], container: { width: 720, maxHeight: 900 },
  };

  it('posts the host info once to the issuer with the view token', async () => {
    const f = vi.fn(async () => resp(204));
    await sendHostReport({ url: VIEW, token: 'tok' }, info, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/connect/host-report');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual(info);
  });

  it('ignores failures and bad view urls', async () => {
    const f = vi.fn(async () => { throw new TypeError('blocked'); });
    await expect(sendHostReport({ url: VIEW, token: 'tok' }, info, f as unknown as typeof fetch)).resolves.toBeUndefined();
    const g = vi.fn();
    await sendHostReport({ url: 'https://a.io/x', token: 'tok' }, info, g as unknown as typeof fetch);
    expect(g).not.toHaveBeenCalled();
  });

  it('drops a platform outside the enum', () => {
    expect(JSON.parse(hostReportBody({ platform: 'toaster' as HostInfo['platform'] }))).toEqual({});
  });

  it('keeps the body within 2 KB in multibyte text, with modes from the enum only', () => {
    const body = hostReportBody({
      host: { name: '名'.repeat(64), version: '版'.repeat(64) }, platform: 'desktop', displayMode: 'fullscreen',
      displayModes: ['inline', '全'.repeat(64), 'fullscreen', 'pip', 'theater'],
    });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(2048);
    expect(JSON.parse(body).displayModes).toEqual(['inline', 'fullscreen', 'pip']);
  });

  it('keeps the body within 2 KB and the mode list within 8 entries of 64 characters', () => {
    const big: HostInfo = { ...info, displayModes: Array.from({ length: 20 }, (_, i) => `m${i}`.padEnd(100, 'x')), host: { name: 'n'.repeat(5000) } };
    const body = hostReportBody(big);
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(2048);
    const parsed = JSON.parse(body);
    expect(parsed.displayModes.length).toBeLessThanOrEqual(8);
    for (const m of parsed.displayModes) expect(m.length).toBeLessThanOrEqual(64);
  });
});

describe('postInput', () => {
  const source = (o: Partial<FrameSource> = {}): FrameSource => ({
    view: () => ({ token: 'tok', url: VIEW, taskId: 't-1' }), renewToken: vi.fn(async () => false), bridgeOnly: () => false, ...o,
  });

  it('posts {event} to the input route with the view token', async () => {
    const f = vi.fn(async (..._a: unknown[]) => resp(202, { ok: true }));
    expect(await postInput(source(), 't-1', [{ kind: 'resume' }], f as unknown as typeof fetch)).toBe('ok');
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/runs/t-1/browser/input');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ event: { kind: 'resume' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('409 means the task is no longer waiting; other errors fail', async () => {
    for (const [st, want] of [[409, 'not_waiting'], [422, 'failed'], [413, 'failed']] as const) {
      expect(await postInput(source(), 't-1', [{ kind: 'resume' }], (async () => resp(st)) as unknown as typeof fetch)).toBe(want);
    }
    expect(await postInput(source(), 't-1', [{ kind: 'resume' }], (async () => { throw new TypeError('x'); }) as unknown as typeof fetch)).toBe('failed');
    expect(await postInput(source({ view: () => null }), 't-1', [{ kind: 'resume' }], vi.fn() as unknown as typeof fetch)).toBe('failed');
  });

  it('a refused token is renewed once through the Poller, then retried with the new one', async () => {
    let token = 'tok';
    const src = source({ view: () => ({ token, url: VIEW, taskId: 't-1' }), renewToken: vi.fn(async () => { token = 'tok2'; return true; }) });
    const f = vi.fn(async (..._a: unknown[]) => (f.mock.calls.length === 1 ? resp(401) : resp(202)));
    expect(await postInput(src, 't-1', [{ kind: 'paste', text: 'x' }], f as unknown as typeof fetch)).toBe('ok');
    expect(((f.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe('Bearer tok2');
    const g = vi.fn(async () => resp(401));
    expect(await postInput(source(), 't-1', [{ kind: 'resume' }], g as unknown as typeof fetch)).toBe('failed');
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the view belongs to another task', async () => {
    const f = vi.fn(async (..._a: unknown[]) => resp(202));
    expect(await postInput(source(), 't-OTHER', [{ kind: 'paste', text: 'pw' }], f as unknown as typeof fetch)).toBe('failed');
    expect(f).not.toHaveBeenCalled();
  });

  it('a task switch during a token renewal sends nothing to the new task', async () => {
    let view = { token: 'tok', url: VIEW, taskId: 't-1' };
    const src = source({
      view: () => view,
      renewToken: vi.fn(async () => { view = { token: 'tok-new', url: 'https://api.example.com/v1/runs/t-2/view', taskId: 't-2' }; return true; }),
    });
    const f = vi.fn(async (..._a: unknown[]) => resp(401));
    expect(await postInput(src, 't-1', [{ kind: 'paste', text: 'pw' }], f as unknown as typeof fetch)).toBe('failed');
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toContain('/runs/t-1/');
  });

  it('only 429 comes back as the wait the server asked for (Retry-After, default 1 s); 503 fails', async () => {
    const busy = (st: number, after?: string) =>
      (async () => ({ status: st, ok: false, headers: new Headers(after ? { 'Retry-After': after } : {}), json: async () => null })) as unknown as typeof fetch;
    expect(await postInput(source(), 't-1', [{ kind: 'paste', text: 'x' }], busy(429, '1'))).toEqual({ retryAfterMs: 1000 });
    // 503 may come after part of a batch was forwarded: a failure, never resent.
    expect(await postInput(source(), 't-1', [{ kind: 'paste', text: 'x' }], busy(503))).toBe('failed');
    expect(await postInput(source(), 't-1', [{ kind: 'paste', text: 'x' }], busy(429, '2'))).toEqual({ retryAfterMs: 2000 });
    expect(await postInput(source(), 't-1', [{ kind: 'paste', text: 'x' }], busy(429, '600'))).toEqual({ retryAfterMs: 5000 });
  });

  it('several events go as one {events} request, in order', async () => {
    const f = vi.fn(async (..._a: unknown[]) => resp(202));
    const evs = [{ kind: 'key', type: 'char', text: 'a' }, { kind: 'paste', text: 'bc' }] as const;
    expect(await postInput(source(), 't-1', [...evs], f as unknown as typeof fetch)).toBe('ok');
    expect(JSON.parse((f.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ events: evs });
    expect(await postInput(source(), 't-1', [], f as unknown as typeof fetch)).toBe('ok');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('postControl', () => {
  const source = (o: Partial<FrameSource> = {}): FrameSource => ({
    view: () => ({ token: 'tok', url: VIEW, taskId: 't-1' }), renewToken: vi.fn(async () => false), bridgeOnly: () => false, ...o,
  });
  const answer = (st: number) => (async () => ({ status: st, ok: st >= 200 && st < 300, headers: new Headers(st === 429 ? { 'Retry-After': '2' } : {}), json: async () => null })) as unknown as typeof fetch;

  it('posts to the control route with the view token and a 5 s timeout', async () => {
    const f = vi.fn(async (..._a: unknown[]) => resp(202, { accepted: true }));
    expect(await postControl(source(), 't-1', f as unknown as typeof fetch)).toBe('ok');
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/runs/t-1/browser/control');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps 202 to ok, 409 to not_live, 429 to busy, 5xx and network errors to failed', async () => {
    for (const [st, want] of [[202, 'ok'], [409, 'not_live'], [429, 'busy'], [500, 'failed'], [503, 'failed'], [404, 'failed']] as const) {
      expect(await postControl(source(), 't-1', answer(st))).toBe(want);
    }
    expect(await postControl(source(), 't-1', (async () => { throw new TypeError('x'); }) as unknown as typeof fetch)).toBe('failed');
    expect(await postControl(source({ view: () => null }), 't-1', vi.fn() as unknown as typeof fetch)).toBe('failed');
  });

  it('renews a refused token once, then retries with the new one', async () => {
    let token = 'tok';
    const src = source({ view: () => ({ token, url: VIEW, taskId: 't-1' }), renewToken: vi.fn(async () => { token = 'tok2'; return true; }) });
    const f = vi.fn(async (..._a: unknown[]) => (f.mock.calls.length === 1 ? resp(401) : resp(202)));
    expect(await postControl(src, 't-1', f as unknown as typeof fetch)).toBe('ok');
    expect(((f.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe('Bearer tok2');
    const g = vi.fn(async () => resp(401));
    expect(await postControl(source({ renewToken: vi.fn(async () => true) }), 't-1', g as unknown as typeof fetch)).toBe('failed');
    expect(g).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for another task, including after a renewal', async () => {
    const f = vi.fn(async (..._a: unknown[]) => resp(202));
    expect(await postControl(source(), 't-OTHER', f as unknown as typeof fetch)).toBe('failed');
    expect(f).not.toHaveBeenCalled();
    let view = { token: 'tok', url: VIEW, taskId: 't-1' };
    const src = source({
      view: () => view,
      renewToken: vi.fn(async () => { view = { token: 'n', url: 'https://api.example.com/v1/runs/t-2/view', taskId: 't-2' }; return true; }),
    });
    const g = vi.fn(async (..._a: unknown[]) => resp(401));
    expect(await postControl(src, 't-1', g as unknown as typeof fetch)).toBe('failed');
    expect(g).toHaveBeenCalledTimes(1);
  });
});
