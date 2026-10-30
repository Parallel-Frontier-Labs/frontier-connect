import { describe, expect, it, vi } from 'vitest';
import type { Bridge } from '../src/bridge';
import { Poller } from '../src/poller';
import { merge } from '../src/state';
import { parsePayload, type TaskPayload } from '../src/types';

const base = { task_id: 't', status: 'running', cursor: 1 };

describe('parsePayload browser', () => {
  it('keeps a valid browser state and site', () => {
    expect(parsePayload({ ...base, browser: { state: 'live', site: 'app.example.com' } })?.browser).toEqual({ state: 'live', site: 'app.example.com' });
    expect(parsePayload({ ...base, browser: { state: 'waiting', site: null } })?.browser).toEqual({ state: 'waiting', site: null });
    expect(parsePayload({ ...base, browser: { state: 'ended', site: 'x.io' } })?.browser).toEqual({ state: 'ended', site: 'x.io' });
  });

  it('drops an unknown state, a non-object or null to null', () => {
    for (const b of [null, 'live', 3, [], { state: 'driving', site: 'a.io' }, { state: '__proto__' }, { site: 'a.io' }]) {
      expect(parsePayload({ ...base, browser: b })?.browser).toBeNull();
    }
  });

  it('keeps form: true only on a waiting browser', () => {
    expect(parsePayload({ ...base, browser: { state: 'waiting', site: 'a.io', form: true } })?.browser).toEqual({ state: 'waiting', site: 'a.io', form: true });
    expect(parsePayload({ ...base, browser: { state: 'waiting', site: 'a.io', form: 'yes' } })?.browser).toEqual({ state: 'waiting', site: 'a.io' });
    expect(parsePayload({ ...base, browser: { state: 'live', site: 'a.io', form: true } })?.browser).toEqual({ state: 'live', site: 'a.io' });
    const once = parsePayload({ ...base, browser: { state: 'waiting', site: null, form: true } });
    expect(parsePayload(once)?.browser).toEqual({ state: 'waiting', site: null, form: true });
  });

  it('cleanBrowser keeps user only on waiting', () => {
    expect(parsePayload({ ...base, browser: { state: 'waiting', site: 'a.io', user: true } })?.browser).toEqual({ state: 'waiting', site: 'a.io', user: true });
    expect(parsePayload({ ...base, browser: { state: 'waiting', site: 'a.io', user: 'yes' } })?.browser).toEqual({ state: 'waiting', site: 'a.io' });
    expect(parsePayload({ ...base, browser: { state: 'live', site: 'a.io', user: true } })?.browser).toEqual({ state: 'live', site: 'a.io' });
    const once = parsePayload({ ...base, browser: { state: 'waiting', site: null, user: true } });
    expect(parsePayload(once)?.browser).toEqual({ state: 'waiting', site: null, user: true });
  });

  it('form wins over user', () => {
    expect(parsePayload({ ...base, browser: { state: 'waiting', site: 'a.io', form: true, user: true } })?.browser).toEqual({ state: 'waiting', site: 'a.io', form: true });
  });

  it('is absent when the payload does not carry it', () => {
    expect(parsePayload(base)).not.toHaveProperty('browser');
  });

  it('accepts only a hostname of at most 253 characters as the site', () => {
    const site = (s: unknown) => parsePayload({ ...base, browser: { state: 'live', site: s } })?.browser?.site;
    expect(site('a'.repeat(63) + '.example.com')).toBe('a'.repeat(63) + '.example.com');
    expect(site('x'.repeat(254))).toBeNull();
    expect(site('x'.repeat(253))).toBe('x'.repeat(253));
    for (const bad of ['', 'https://a.io', 'a.io/path', 'a b.io', '<b>.io', 'a.io\n', 7, {}, 'user@a.io']) expect(site(bad)).toBeNull();
  });

  it('survives a second parse (already-parsed payloads go through parsePayload again)', () => {
    const once = parsePayload({ ...base, browser: { state: 'live', site: 'a.io' } });
    expect(parsePayload(once)?.browser).toEqual({ state: 'live', site: 'a.io' });
  });
});

describe('merge browser', () => {
  const p = (o: Record<string, unknown>) => parsePayload({ ...base, ...o })!;
  it('keeps the previous browser when a newer payload omits it, and takes an explicit null', () => {
    const a = p({ browser: { state: 'live', site: 'a.io' } });
    expect(merge(a, p({ cursor: 2 })).browser).toEqual({ state: 'live', site: 'a.io' });
    expect(merge(a, p({ browser: null })).browser).toBeNull();
    expect(merge(a, p({ browser: { state: 'waiting', site: 'a.io' } })).browser?.state).toBe('waiting');
  });
});

describe('Poller view access for the browser feed', () => {
  const VIEW = 'https://api.example.com/v1/runs/t/view';
  const mk = (o: Partial<TaskPayload> = {}): TaskPayload =>
    parsePayload({ ...base, status: 'running', view: { token: 'tok', expires_in_s: 1800, url: VIEW }, ...o })!;
  function rig(getTask: Bridge['getTask']) {
    const bridge = {
      onPayload: () => {}, getTask: vi.fn(getTask), theme: () => 'light', onThemeChange: () => {}, onConnectError: () => {},
      canCallTools: () => false, onReady: () => {}, answer: async () => ({ kind: 'failed', message: '' }),
      onList: () => {}, listTasks: async () => ({ kind: 'failed', message: '' }), deleteTask: async () => ({ kind: 'failed', message: '' }),
      fileLink: async () => ({ kind: 'failed', message: '' }), openLink: async () => false,
    } as Bridge;
    const poller = new Poller({ bridge, fetchImpl: vi.fn() as unknown as typeof fetch, setTimer: () => 0, clearTimer: () => {}, onUpdate: () => {} });
    return { poller, bridge };
  }

  it('view() returns the current view token and url, or null', () => {
    const r = rig(async () => null);
    expect(r.poller.view()).toBeNull();
    r.poller.start(mk());
    expect(r.poller.view()).toEqual({ token: 'tok', url: VIEW, taskId: 't' });
  });

  it('renewToken() refreshes through the bridge once for concurrent callers and reports a new token', async () => {
    let resolve!: (p: TaskPayload) => void;
    const r = rig(() => new Promise((res) => (resolve = res)));
    r.poller.start(mk());
    const a = r.poller.renewToken();
    const b = r.poller.renewToken();
    expect(r.bridge.getTask).toHaveBeenCalledTimes(1);
    resolve(mk({ view: { token: 'tok2', expires_in_s: 1800, url: VIEW } }));
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(r.poller.view()?.token).toBe('tok2');
  });

  it('renewToken() reports false when the token did not change', async () => {
    const r = rig(async () => mk());
    r.poller.start(mk());
    expect(await r.poller.renewToken()).toBe(false);
  });

  it('poke() reads now instead of at the next interval, and never runs two reads at once', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    let release!: () => void;
    const bridge = {
      onPayload: () => {}, getTask: vi.fn(async () => null), theme: () => 'light', onThemeChange: () => {}, onConnectError: () => {},
      canCallTools: () => false, onReady: () => {}, answer: async () => ({ kind: 'failed', message: '' }),
      onList: () => {}, listTasks: async () => ({ kind: 'failed', message: '' }), deleteTask: async () => ({ kind: 'failed', message: '' }),
      fileLink: async () => ({ kind: 'failed', message: '' }), openLink: async () => false,
    } as Bridge;
    const f = vi.fn(() => new Promise<Response>((res) => (release = () => res({ status: 204, ok: true, json: async () => null } as unknown as Response))));
    const poller = new Poller({
      bridge, fetchImpl: f as unknown as typeof fetch,
      setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
      clearTimer: (h) => { const i = timers.indexOf(h as { fn: () => void; ms: number }); if (i >= 0) timers.splice(i, 1); },
      onUpdate: () => {},
    });
    poller.start(mk({ status: 'waiting_for_you' }));
    expect(timers.map((t) => t.ms)).toEqual([5000]);
    poller.poke();
    expect(timers.map((t) => t.ms)).toEqual([0]);
    timers.shift()!.fn();
    await Promise.resolve();
    expect(f).toHaveBeenCalledTimes(1);
    poller.poke(); // a read is in flight: no second one, the next comes at once
    expect(timers).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(timers.map((t) => t.ms)).toEqual([0]));
    timers.shift()!.fn();
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    release();
    await vi.waitFor(() => expect(timers.map((t) => t.ms)).toEqual([5000]));
  });

  it('parses credits: a finite non-negative number, else null', () => {
    expect(parsePayload({ ...base, credits: 12 })?.credits).toBe(12);
    expect(parsePayload({ ...base, credits: 12.6 })?.credits).toBe(13);
    expect(parsePayload({ ...base, credits: -1 })?.credits).toBeNull();
    expect(parsePayload({ ...base, credits: 'x' })?.credits).toBeNull();
    expect(parsePayload({ ...base, credits: NaN })?.credits).toBeNull();
    expect(parsePayload({ ...base, credits: Infinity })?.credits).toBeNull();
    expect(parsePayload({ ...base, credits: 1e300 })?.credits).toBeNull();
    expect(parsePayload(base)?.credits).toBeNull();
  });
});
