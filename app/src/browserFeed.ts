import type { HostInfo } from './bridge';
import type { BrowserInput, SendOutcome } from './browserInput';
import { cleanSite } from './types';

/** Where the card reads the view token: the Poller, which also renews it. */
export interface FrameSource {
  /** The current view token and url, or null when the card has none (yet). */
  view(): { token: string; url: string; taskId: string } | null;
  /** The token was refused: fetch a fresh one (through the host). True when a new token arrived. */
  renewToken(): Promise<boolean>;
  /** The card cannot fetch from the server directly in this host (it reads through the host only). */
  bridgeOnly(): boolean;
}

/** One screenshot of the task's browser. `seq` grows with every frame the feed delivers. */
export interface BrowserFrame { seq: number; awaiting: boolean; site: string | null; w: number; h: number; data: string; at: number }
export type FeedMode = 'preview' | 'control';

export const FEED_INTERVAL_MS: Readonly<Record<FeedMode, number>> = { preview: 500, control: 200 };
/** Wait after a 429, a 5xx, a network error or a missing token. */
export const FEED_BACKOFF_MS = 1000;
/** Token refusals in a row (each after a renewal) before the feed gives up. */
const MAX_REFUSALS = 3;
const MAX_SIDE = 8192;
const MAX_DATA = 8_000_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** `<issuer>/v1/runs/<id>/view` split into the issuer (origin plus any path prefix) and the id. */
function splitView(viewUrl: string): { issuer: string; id: string } | null {
  let u: URL;
  try {
    u = new URL(viewUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.search || u.hash) return null;
  const m = /^(.*)\/v1\/runs\/([^/]+)\/view$/.exec(u.pathname);
  return m ? { issuer: `${u.origin}${m[1]}`, id: m[2]! } : null;
}

export function frameUrl(viewUrl: string): string | null {
  const v = splitView(viewUrl);
  return v ? `${v.issuer}/v1/runs/${v.id}/browser/frame` : null;
}

export function inputUrl(viewUrl: string): string | null {
  const v = splitView(viewUrl);
  return v ? `${v.issuer}/v1/runs/${v.id}/browser/input` : null;
}

export function controlUrl(viewUrl: string): string | null {
  const v = splitView(viewUrl);
  return v ? `${v.issuer}/v1/runs/${v.id}/browser/control` : null;
}

export function hostReportUrl(viewUrl: string): string | null {
  const v = splitView(viewUrl);
  return v ? `${v.issuer}/v1/connect/host-report` : null;
}

function cleanFrame(v: unknown, seq: number): BrowserFrame | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const side = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_SIDE;
  if (!side(o.w) || !side(o.h)) return null;
  if (typeof o.data !== 'string' || !o.data || o.data.length > MAX_DATA || !BASE64.test(o.data)) return null;
  return {
    seq,
    awaiting: o.awaiting === true,
    site: cleanSite(o.site),
    w: o.w as number,
    h: o.h as number,
    data: o.data,
    at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0,
  };
}

/** What the feed can do right now: frames flow (`ok`), the direct path is unavailable and it
 * retries every 30 s (`unavailable`), or it gave up for good (`disabled`). */
export type FeedStatus = 'ok' | 'unavailable' | 'disabled';

export interface BrowserFeedOptions {
  source: FrameSource;
  /** A new frame, or null when the server has none (no browser open, or no frame yet). */
  onFrame: (f: BrowserFrame | null) => void;
  /** The feed's status changed (see FeedStatus). */
  onStatus?: (s: FeedStatus) => void;
  fetchImpl?: typeof fetch;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** True while the page is hidden (defaults to `document.hidden`). */
  hidden?: () => boolean;
}

/** `p`, or a rejection as soon as `signal` aborts (a body stream that stalls must not hold the feed). */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const off = () => reject(new Error('aborted'));
    signal.addEventListener('abort', off, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', off); resolve(v); },
      (e) => { signal.removeEventListener('abort', off); reject(e); },
    );
  });
}

/** A frame request that has not answered by then is aborted (and counts as a failure). */
export const FEED_TIMEOUT_MS = 5000;
/** While the card reads through the host only, the feed tries the direct path this often. */
export const FEED_RETRY_DIRECT_MS = 30_000;
/** read(): wait on the 30 s retry instead of the usual interval. */
const PARK = -2;

/**
 * Polls the task's browser frames: one request at a time (aborted after 5 s), every 500 ms in
 * preview and 200 ms in control, paused while the page is hidden or the preview is out of view.
 * The view token comes from the Poller; a refused token asks the Poller to renew it rather than
 * doing so twice. When the Poller reads through the host only, the feed tries the direct path
 * every 30 s and resumes as soon as it answers.
 */
export class BrowserFeed {
  private o: Required<Omit<BrowserFeedOptions, 'onStatus'>> & Pick<BrowserFeedOptions, 'onStatus'>;
  private mode: FeedMode = 'preview';
  private running = false;
  private busy = false;
  private visible = true;
  private timer: unknown = null;
  private gen = 0;
  private seq = 0;
  private refusals = 0;
  private off = false;
  private abort: AbortController | null = null;
  private deadline: unknown = null;
  /** The task the feed reads; fixed by the first view it sees. */
  private taskId: string | null = null;
  /** While bridge-only: allowed to try the direct path (set when the 30 s retry comes due). */
  private probing = false;
  private status: FeedStatus = 'ok';

  constructor(o: BrowserFeedOptions) {
    this.o = {
      fetchImpl: (...a) => fetch(...a),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      hidden: () => typeof document !== 'undefined' && document.hidden === true,
      ...o,
    };
  }

  get disabled(): boolean {
    return this.off;
  }

  get currentMode(): FeedMode {
    return this.mode;
  }

  get currentStatus(): FeedStatus {
    return this.status;
  }

  start(): void {
    if (this.running || this.off) return;
    this.running = true;
    this.kick();
  }

  stop(): void {
    this.running = false;
    this.gen++;
    this.busy = false;
    this.abort?.abort();
    this.abort = null;
    if (this.deadline !== null) this.o.clearTimer(this.deadline);
    this.deadline = null;
    this.clear();
  }

  setMode(m: FeedMode): void {
    if (m === this.mode) return;
    this.mode = m;
    if (this.timer !== null && !this.parked()) this.schedule(FEED_INTERVAL_MS[m]);
  }

  /** The preview scrolled into or out of view. */
  setVisible(v: boolean): void {
    this.visible = v;
    if (v) this.kick();
  }

  /** The page's visibility changed: resume if it is shown again. */
  wake(): void {
    this.kick();
  }

  private paused(): boolean {
    return !this.visible || this.o.hidden();
  }

  /** Waiting on the 30 s direct retry: wake-ups must not shorten it. */
  private parked(): boolean {
    return this.status === 'unavailable' && !this.probing;
  }

  /** Fetch soon, unless a request is in flight, a fetch is already due, or the feed is parked. */
  private kick(): void {
    if (!this.running || this.off || this.busy || this.timer !== null || this.paused()) return;
    if (this.parked()) return this.schedule(FEED_RETRY_DIRECT_MS);
    this.schedule(0);
  }

  private clear(): void {
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clear();
    if (!this.running || this.off) return;
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private setStatus(s: FeedStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.o.onStatus?.(s);
  }

  private disable(): void {
    if (this.off) return;
    this.off = true;
    this.stop();
    this.setStatus('disabled');
  }

  /** The direct path is unavailable: say so and try it again in 30 s. */
  private park(): void {
    this.probing = false;
    this.setStatus('unavailable');
    this.schedule(FEED_RETRY_DIRECT_MS);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.busy || this.paused()) return;
    const bridgeOnly = this.o.source.bridgeOnly();
    if (bridgeOnly && !this.probing) {
      // Bridge-only: the first time, wait 30 s; when that retry comes due, try the direct path.
      if (this.status === 'unavailable') this.probing = true;
      else return this.park();
    }
    const view = this.o.source.view();
    if (!view) return this.schedule(FEED_BACKOFF_MS);
    if (this.taskId === null) this.taskId = view.taskId;
    // Another task's token: not this feed's to read (the card is about to show that task).
    if (view.taskId !== this.taskId) return this.schedule(FEED_BACKOFF_MS);
    const url = frameUrl(view.url);
    if (!url) return this.disable();
    const gen = this.gen;
    this.busy = true;
    let next = FEED_BACKOFF_MS;
    try {
      next = await this.read(url, view.token, gen);
    } finally {
      if (gen === this.gen) {
        this.busy = false;
        if (next === PARK) this.park();
        else if (next >= 0) this.schedule(next);
      }
    }
  }

  /** A failure: the usual backoff, or the 30 s retry while the card reads through the host only. */
  private failed(): number {
    return this.o.source.bridgeOnly() ? PARK : FEED_BACKOFF_MS;
  }

  /** A frame (or an empty answer) arrived: the direct path works. */
  private answered(): void {
    this.refusals = 0;
    if (this.o.source.bridgeOnly()) this.probing = true;
    this.setStatus('ok');
  }

  /** One request, aborted if it (headers or body) has not finished within FEED_TIMEOUT_MS. */
  private async read(url: string, token: string, gen: number): Promise<number> {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    this.abort = ctl;
    const timeout = ctl ? this.o.setTimer(() => ctl.abort(), FEED_TIMEOUT_MS) : null;
    this.deadline = timeout;
    try {
      return await this.exchange(url, token, gen, ctl?.signal);
    } finally {
      if (timeout !== null && this.deadline === timeout) {
        this.o.clearTimer(timeout);
        this.deadline = null;
      }
      if (this.abort === ctl) this.abort = null;
    }
  }

  /** Returns the wait before the next request, PARK, or -1 when the feed must not continue. */
  private async exchange(url: string, token: string, gen: number, signal?: AbortSignal): Promise<number> {
    let res: Response;
    try {
      res = await this.o.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) });
    } catch {
      return gen === this.gen ? this.failed() : -1;
    }
    if (gen !== this.gen) return -1;
    if (res.status === 401) {
      // Refused with a token the Poller has since replaced: just try again with the new one.
      const cur = this.o.source.view();
      if (cur && (cur.token !== token || cur.taskId !== this.taskId)) return 0;
      if (++this.refusals >= MAX_REFUSALS) {
        this.disable();
        return -1;
      }
      const renewed = await this.o.source.renewToken().catch(() => false);
      if (gen !== this.gen) return -1;
      return renewed ? 0 : FEED_BACKOFF_MS;
    }
    if (res.status === 204) {
      this.answered();
      this.o.onFrame(null);
      return FEED_INTERVAL_MS[this.mode];
    }
    if (!res.ok) return this.failed();
    let body: unknown;
    try {
      body = await untilAborted(res.json(), signal);
    } catch {
      if (gen !== this.gen) return -1;
      return signal?.aborted ? this.failed() : FEED_INTERVAL_MS[this.mode];
    }
    if (gen !== this.gen) return -1;
    // The view moved to another task while this frame was in flight: drop it.
    if (this.o.source.view()?.taskId !== this.taskId) return FEED_BACKOFF_MS;
    this.answered();
    const f = cleanFrame(body, this.seq + 1);
    if (f) {
      this.seq = f.seq;
      this.o.onFrame(f);
    }
    return FEED_INTERVAL_MS[this.mode];
  }
}

/** The host report body: capped lists and strings (at most about 1 KB, under the 2 KB limit). */
export function hostReportBody(info: HostInfo): string {
  const s = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 64) : undefined);
  const out: HostInfo = {};
  if (info.host) {
    const name = s(info.host.name);
    const version = s(info.host.version);
    if (name || version) out.host = { ...(name ? { name } : {}), ...(version ? { version } : {}) };
  }
  const platform = (['web', 'desktop', 'mobile'] as const).find((x) => x === info.platform);
  if (platform) out.platform = platform;
  if (Array.isArray(info.displayModes)) {
    out.displayModes = info.displayModes.filter((m) => m === 'inline' || m === 'fullscreen' || m === 'pip').slice(0, 8);
  }
  const mode = (['inline', 'fullscreen', 'pip'] as const).find((m) => m === info.displayMode);
  if (mode) out.displayMode = mode;
  if (info.container && typeof info.container === 'object') {
    const box: NonNullable<HostInfo['container']> = {};
    for (const k of ['width', 'height', 'maxWidth', 'maxHeight'] as const) {
      const n = info.container[k];
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) box[k] = Math.round(n);
    }
    if (Object.keys(box).length) out.container = box;
  }
  // The name and version are at most 64 characters each, the modes an enum: far under 2 KB even in
  // multibyte text. Dropping them is the last resort.
  let body = JSON.stringify(out);
  if (new TextEncoder().encode(body).length > 2048) body = JSON.stringify({ ...out, host: undefined });
  return body;
}

/** Tell the server which host shows the card (once per card mount). Failures are ignored. */
export async function sendHostReport(view: { url: string; token: string }, info: HostInfo, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<void> {
  const url = hostReportUrl(view.url);
  if (!url) return;
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${view.token}`, 'Content-Type': 'application/json' },
      body: hostReportBody(info),
    });
  } catch {
    /* a report is best-effort */
  }
}

/**
 * Input events to the task's browser (POST <issuer>/v1/runs/<id>/browser/input): one event as
 * `{event}`, several (typing, in order) as `{events}`, with the view token from `source`.
 * Bound to `taskId`: when the card's view belongs to another task (the user opened another one),
 * nothing is sent, checked before every request, the one after a token renewal included. A refused
 * token is renewed through the Poller once; 409 means the task no longer waits for the user. Only
 * 429 comes back as "busy" (the server refuses it before forwarding anything, so a resend is
 * safe); 503, network errors and timeouts are failures and never resent, since part of a batch may
 * already have reached the browser. Aborted after FEED_TIMEOUT_MS.
 */
export async function postInput(
  source: FrameSource, taskId: string, events: BrowserInput[], fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<SendOutcome> {
  if (!events.length) return 'ok';
  const body = JSON.stringify(events.length === 1 ? { event: events[0] } : { events });
  for (let attempt = 0; attempt < 2; attempt++) {
    const view = source.view();
    const url = view ? inputUrl(view.url) : null;
    if (!view || !url || view.taskId !== taskId) return 'failed';
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), FEED_TIMEOUT_MS) : null;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${view.token}`, 'Content-Type': 'application/json' },
        body,
        ...(ctl ? { signal: ctl.signal } : {}),
      });
    } catch {
      return 'failed';
    } finally {
      if (t !== null) clearTimeout(t);
    }
    if (res.status === 409) return 'not_waiting';
    if (res.ok) return 'ok';
    if (res.status === 429) {
      const raw = res.headers?.get?.('Retry-After');
      const after = raw ? Number(raw) : NaN;
      return { retryAfterMs: Number.isFinite(after) && after >= 0 ? Math.min(after, 5) * 1000 : 1000 };
    }
    if (res.status === 401 && attempt === 0) {
      const renewed = await source.renewToken().catch(() => false);
      if (renewed) continue;
    }
    return 'failed';
  }
  return 'failed';
}

/** What a Take control request got: requested (`ok`, not yet paused), the browser step already
 * ended (`not_live`), rate limited (`busy`: an earlier request is still in its window), or failed. */
export type ControlOutcome = 'ok' | 'not_live' | 'busy' | 'failed';

/**
 * Ask the server to pause the agent so the user can drive (POST <issuer>/v1/runs/<id>/browser/control).
 * 202 means requested, not paused: the snapshot says when the pause lands. Bound to `taskId` like
 * postInput (nothing goes to another task, checked before every request), a refused token is renewed
 * through the Poller once, and the request is aborted after FEED_TIMEOUT_MS.
 */
export async function postControl(
  source: FrameSource, taskId: string, fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<ControlOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const view = source.view();
    const url = view ? controlUrl(view.url) : null;
    if (!view || !url || view.taskId !== taskId) return 'failed';
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), FEED_TIMEOUT_MS) : null;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${view.token}` },
        ...(ctl ? { signal: ctl.signal } : {}),
      });
    } catch {
      return 'failed';
    } finally {
      if (t !== null) clearTimeout(t);
    }
    if (res.ok) return 'ok';
    if (res.status === 409) return 'not_live';
    if (res.status === 429) return 'busy';
    if (res.status === 401 && attempt === 0) {
      const renewed = await source.renewToken().catch(() => false);
      if (renewed) continue;
    }
    return 'failed';
  }
  return 'failed';
}
