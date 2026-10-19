import { describe, expect, it, vi } from 'vitest';
import { Poller } from '../src/poller';
import type { Bridge } from '../src/bridge';
import type { TaskPayload } from '../src/types';

const URL_ = 'https://api.example.com/v1/runs/t/view';
const mk = (o: Partial<TaskPayload> = {}): TaskPayload => ({
  task_id: 't', status: 'running', title: 'T', plan: [], sections: [], live: null, estimate: null, open_ask: null,
  deliverables: [], result: null, work_ms: 0, usage: null, events: [], cursor: 3, more: false,
  view: { token: 'tok', expires_in_s: 1800, url: URL_ }, ...o,
});
const resp = (status: number, body?: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;

function rig(fetchImpl: (...a: unknown[]) => Promise<Response>, getTask: Bridge['getTask'] = async () => null, startAt = 0) {
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let id = 0;
  let t = startAt;
  const bridge: Bridge = {
    onPayload: () => {}, getTask: vi.fn(getTask), theme: () => 'light', onThemeChange: () => {}, onConnectError: () => {},
    canCallTools: () => false, onReady: () => {}, answer: async () => ({ kind: 'failed', message: '' }),
  };
  const updates: TaskPayload[] = [];
  const poller = new Poller({
    bridge, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t,
    setTimer: (fn, ms) => { const h = { fn, ms, id: ++id }; timers.push(h); return h.id; },
    clearTimer: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
    onUpdate: (p) => updates.push(p),
  });
  const fire = async () => { const x = timers.shift(); x!.fn(); await vi.waitFor(() => {}); await new Promise((r) => setTimeout(r, 0)); };
  return { poller, timers, bridge, updates, fire, setNow: (n: number) => { t = n; } };
}

describe('Poller', () => {
  it('polls the view url directly with a bearer header and stops at a terminal status', async () => {
    const f = vi.fn(async () => resp(200, mk({ status: 'done', view: undefined, cursor: 5 })));
    const r = rig(f);
    r.poller.start(mk());
    expect(r.timers[0].ms).toBe(1000);
    await r.fire();
    expect(f).toHaveBeenCalledWith(`${URL_}?after=3`, { headers: { Authorization: 'Bearer tok' } });
    expect(r.updates.at(-1)?.status).toBe('done');
    expect(r.updates.at(-1)?.view?.token).toBe('tok');
    expect(r.timers.length).toBe(0);
    expect(r.poller.mode).toBe('direct');
  });

  it('falls back to the bridge when the fetch throws', async () => {
    const getTask = vi.fn(async () => mk({ cursor: 4 }));
    const r = rig(async () => { throw new TypeError('blocked'); }, getTask);
    r.poller.start(mk());
    await r.fire();
    expect(r.poller.mode).toBe('bridge');
    expect(r.timers[0].ms).toBe(3000);
    await r.fire();
    expect(getTask).toHaveBeenCalledWith('t', 3);
  });

  it('falls back on 403 without a refresh', async () => {
    const r = rig(async () => resp(403));
    r.poller.start(mk());
    await r.fire();
    expect(r.poller.mode).toBe('bridge');
    expect(r.bridge.getTask).not.toHaveBeenCalled();
  });

  it('refreshes once on 401, retries direct and stays direct', async () => {
    let n = 0;
    const f = vi.fn(async (_u: unknown, init: unknown) => {
      n++;
      const auth = (init as { headers: Record<string, string> }).headers.Authorization;
      return auth === 'Bearer fresh' ? resp(200, mk({ view: undefined, cursor: 6 })) : resp(401);
    });
    const getTask = vi.fn(async () => mk({ view: { token: 'fresh', expires_in_s: 1800, url: URL_ } }));
    const r = rig(f as never, getTask);
    r.poller.start(mk());
    await r.fire();
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(n).toBe(2);
    expect(r.poller.mode).toBe('direct');
    expect(r.updates.at(-1)?.cursor).toBe(6);
  });

  it('goes to the bridge when the 401 refresh yields no new token', async () => {
    const r = rig(async () => resp(401), async () => null);
    r.poller.start(mk());
    await r.fire();
    expect(r.poller.mode).toBe('bridge');
  });

  it('refreshes through the bridge when the token is within 120 s of expiry', async () => {
    const order: string[] = [];
    const f = vi.fn(async () => { order.push('fetch'); return resp(200, mk({ view: undefined })); });
    const getTask = vi.fn(async () => { order.push('bridge'); return mk({ view: { token: 'tok2', expires_in_s: 1800, url: URL_ } }); });
    const r = rig(f, getTask, 0);
    r.poller.start(mk({ view: { token: 'tok', expires_in_s: 1800, url: URL_ } }));
    r.setNow(1_800_000 - 100_000);
    await r.fire();
    expect(order).toEqual(['bridge', 'fetch']);
    expect(f).toHaveBeenCalledWith(`${URL_}?after=3`, { headers: { Authorization: 'Bearer tok2' } });
  });

  it('polls every 5 s while waiting', async () => {
    const r = rig(async () => resp(200, mk({ status: 'waiting_for_answer', view: undefined })));
    r.poller.start(mk());
    await r.fire();
    expect(r.timers[0].ms).toBe(5000);
  });

  it('stop() cancels the pending tick', () => {
    const r = rig(async () => resp(200, mk()));
    r.poller.start(mk());
    r.poller.stop();
    expect(r.timers.length).toBe(0);
  });

  describe('stale in-flight responses', () => {
    const deferred = <T,>() => {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => { resolve = r; });
      return { promise, resolve };
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const tick = async (r: ReturnType<typeof rig>) => { r.timers.shift()!.fn(); await flush(); };

    it('stop during a direct fetch: no update and no new timer', async () => {
      const d = deferred<Response>();
      const r = rig(() => d.promise);
      r.poller.start(mk());
      const n = r.updates.length;
      await tick(r);
      r.poller.stop();
      d.resolve(resp(200, mk({ view: undefined, cursor: 4 })));
      await flush();
      expect(r.updates.length).toBe(n);
      expect(r.timers.length).toBe(0);
    });

    it('start during a direct fetch: the newer payload wins', async () => {
      const d = deferred<Response>();
      const r = rig(() => d.promise);
      r.poller.start(mk());
      await tick(r);
      r.poller.start(mk({ status: 'done', cursor: 9 }));
      d.resolve(resp(200, mk({ status: 'running', view: undefined, cursor: 4 })));
      await flush();
      expect(r.updates.at(-1)?.status).toBe('done');
      expect(r.updates.at(-1)?.cursor).toBe(9);
      expect(r.timers.length).toBe(0);
    });

    const intoBridge = async () => {
      const d = deferred<TaskPayload | null>();
      const r = rig(async () => { throw new TypeError('blocked'); }, () => d.promise);
      r.poller.start(mk());
      await tick(r); // the fetch throws, so the poller switches to the bridge
      expect(r.poller.mode).toBe('bridge');
      return { r, d };
    };

    it('stop during a bridge getTask: no update and no new timer', async () => {
      const { r, d } = await intoBridge();
      await tick(r);
      const n = r.updates.length;
      r.poller.stop();
      d.resolve(mk({ cursor: 4 }));
      await flush();
      expect(r.updates.length).toBe(n);
      expect(r.timers.length).toBe(0);
    });

    it('start during a bridge getTask: the newer payload wins', async () => {
      const { r, d } = await intoBridge();
      await tick(r);
      r.poller.start(mk({ status: 'done', cursor: 9 }));
      d.resolve(mk({ status: 'running', cursor: 4 }));
      await flush();
      expect(r.updates.at(-1)?.status).toBe('done');
      expect(r.updates.at(-1)?.cursor).toBe(9);
      expect(r.timers.length).toBe(0);
    });

    it('start during a 401 refresh: the newer payload wins and nothing is retried', async () => {
      const d = deferred<TaskPayload | null>();
      const f = vi.fn(async () => resp(401));
      const r = rig(f as never, () => d.promise);
      r.poller.start(mk());
      await tick(r);
      r.poller.start(mk({ status: 'done', cursor: 9 }));
      d.resolve(mk({ view: { token: 'fresh', expires_in_s: 1800, url: URL_ }, cursor: 4 }));
      await flush();
      expect(f).toHaveBeenCalledTimes(1);
      expect(r.updates.at(-1)?.status).toBe('done');
      expect(r.updates.at(-1)?.cursor).toBe(9);
      expect(r.updates.at(-1)?.view?.token).toBe('tok');
      expect(r.timers.length).toBe(0);
    });
  });

  describe('task identity', () => {
    it('a different task_id does not inherit payload, view, expiry or mode', async () => {
      const r = rig(async () => { throw new TypeError('blocked'); });
      r.poller.start(mk({ task_id: 'a', cursor: 7, view: { token: 'tokA', expires_in_s: 1, url: URL_ } }));
      await r.fire();
      expect(r.poller.mode).toBe('bridge');
      vi.mocked(r.bridge.getTask).mockClear(); // task a's own expiring token was refreshed above
      r.poller.start(mk({ task_id: 'b', cursor: 0, view: undefined }));
      expect(r.poller.mode).toBe('direct');
      const last = r.updates.at(-1)!;
      expect(last.task_id).toBe('b');
      expect(last.view).toBeUndefined();
      expect(last.cursor).toBe(0);
      await r.fire();
      // the old one-second expiry must not trigger a refresh for task b
      expect(r.bridge.getTask).not.toHaveBeenCalled();
    });

    it('the same task keeps bridge mode after a CSP fallback', async () => {
      const r = rig(async () => { throw new TypeError('blocked'); });
      r.poller.start(mk());
      await r.fire();
      expect(r.poller.mode).toBe('bridge');
      r.poller.start(mk({ cursor: 5 }));
      expect(r.poller.mode).toBe('bridge');
      expect(r.timers[0].ms).toBe(3000);
    });
  });

  describe('bridge mode', () => {
    const bridged = async (getTask: Bridge['getTask']) => {
      const r = rig(async () => { throw new TypeError('blocked'); }, getTask);
      r.poller.start(mk());
      await r.fire();
      expect(r.poller.mode).toBe('bridge');
      return r;
    };

    it('polls every 5 s while waiting', async () => {
      const r = await bridged(async () => mk({ status: 'waiting_for_you', cursor: 4 }));
      await r.fire();
      expect(r.timers[0].ms).toBe(5000);
    });

    it('stops at a terminal status', async () => {
      const r = await bridged(async () => mk({ status: 'done', cursor: 4 }));
      await r.fire();
      expect(r.updates.at(-1)?.status).toBe('done');
      expect(r.timers.length).toBe(0);
    });

    it('keeps polling when getTask returns null', async () => {
      const r = await bridged(async () => null);
      await r.fire();
      expect(r.timers.length).toBe(1);
      expect(r.timers[0].ms).toBe(3000);
    });

    it('keeps polling when getTask throws', async () => {
      const r = await bridged(async () => { throw new Error('host closed'); });
      await r.fire();
      expect(r.timers.length).toBe(1);
      expect(r.timers[0].ms).toBe(3000);
    });
  });
});
