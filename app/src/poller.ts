import type { Bridge } from './bridge';
import { merge } from './state';
import { parsePayload, TERMINAL, type TaskPayload } from './types';

export interface PollerOptions {
  bridge: Bridge;
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  onUpdate: (p: TaskPayload) => void;
  /** The transport changed: 'bridge' when the host blocks the card's own requests. */
  onMode?: (m: 'direct' | 'bridge') => void;
}

const REFRESH_WINDOW_MS = 120_000;
/** While reading through the host only, the direct path is tried again this often. */
export const DIRECT_RETRY_MS = 30_000;
/** After a finished task with files and no `saved`, the card keeps reading it a little longer so
 * the plugin helper's "saved to your folder" acknowledgement shows up: these waits, 3 min in all. */
export const SAVED_BACKOFF_MS: readonly number[] = [5000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000, 25_000];

/** Finished, delivered files, and not (yet) saved to the user's folder. */
const awaitsSaved = (p: TaskPayload) => TERMINAL.has(p.status) && p.deliverables.length > 0 && !p.saved;

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export class Poller {
  mode: 'direct' | 'bridge' = 'direct';
  private payload: TaskPayload | null = null;
  private expiresAt = Infinity;
  private timer: unknown = null;
  private running = false;
  private gen = 0;
  /** Index into SAVED_BACKOFF_MS while waiting for `saved` on a finished turn; -1 otherwise. */
  private settle = -1;
  private settleTurn = 1;
  private bridge: Bridge;
  private fetchImpl: typeof fetch;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (h: unknown) => void;
  private onUpdate: (p: TaskPayload) => void;
  private onMode?: (m: 'direct' | 'bridge') => void;

  constructor(o: PollerOptions) {
    this.bridge = o.bridge;
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
    this.now = o.now ?? Date.now;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onUpdate = o.onUpdate;
    this.onMode = o.onMode;
  }

  start(raw: TaskPayload): void {
    const p = parsePayload(raw);
    if (!p) return;
    this.stop();
    this.running = true;
    if (this.payload && this.payload.task_id !== p.task_id) {
      // A new task must never reuse the old view token, URL, cursor or transport.
      this.payload = null;
      this.expiresAt = Infinity;
      this.everDirect = false;
      this.setMode('direct');
    }
    this.accept(p);
    if (!TERMINAL.has(p.status)) this.schedule();
    else this.beginSettle();
  }

  /** The current view token and url (for the browser frame feed), or null when there is none. */
  view(): { token: string; url: string; taskId: string } | null {
    const p = this.payload;
    return p?.view ? { token: p.view.token, url: p.view.url, taskId: p.task_id } : null;
  }

  private renewing: Promise<boolean> | null = null;
  /** Another reader (the browser frame feed) had the view token refused: fetch a fresh one through
   * the bridge. Concurrent callers share one refresh. True when a new token arrived. */
  renewToken(): Promise<boolean> {
    if (!this.renewing) {
      this.renewing = this.refresh(this.gen).finally(() => {
        this.renewing = null;
      });
    }
    return this.renewing;
  }

  private ticking = false;
  private poked = false;
  /** Read the task now instead of at the next interval (the user just resumed or stopped it). */
  poke(): void {
    if (!this.running) return;
    if (this.ticking) {
      this.poked = true; // the read in flight schedules the next one at once
      return;
    }
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => void this.tick(), 0);
  }

  stop(): void {
    this.running = false;
    this.settle = -1;
    this.gen++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** A direct read of this task has worked at least once (the host does not block it). */
  everDirect = false;
  private probeAt = 0;

  private setMode(m: 'direct' | 'bridge'): void {
    if (m === this.mode) return;
    this.mode = m;
    if (m === 'bridge') this.probeAt = this.now();
    this.onMode?.(m);
  }

  private waiting(): boolean {
    const s = this.payload?.status;
    return s === 'waiting_for_answer' || s === 'waiting_for_you';
  }

  /** A finished turn whose files may still be saved by the plugin helper: read it again on the
   * backoff. Otherwise there is nothing more to read. */
  private beginSettle(): void {
    const p = this.payload;
    if (!p || !awaitsSaved(p)) return this.stop();
    this.settle = 0;
    this.settleTurn = p.turn ?? 1;
    this.schedule();
  }

  private interval(): number {
    if (this.poked) {
      this.poked = false;
      return 0;
    }
    if (this.settle >= 0) return SAVED_BACKOFF_MS[this.settle];
    if (this.waiting()) return 5000;
    return this.mode === 'direct' ? 1000 : 3000;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = this.setTimer(() => void this.tick(), this.interval());
  }

  private accept(p: TaskPayload): void {
    this.payload = merge(this.payload, p);
    const v = this.payload.view;
    if (v && p.view) this.expiresAt = this.now() + v.expires_in_s * 1000;
    this.onUpdate(this.payload);
  }

  private async refresh(gen: number): Promise<boolean> {
    const cur = this.payload;
    if (!cur) return false;
    const before = cur.view?.token;
    try {
      const p = parsePayload(await this.bridge.getTask(cur.task_id, cur.cursor));
      if (gen !== this.gen) return false;
      if (!p) return false;
      this.accept(p);
      return !!p.view && p.view.token !== before;
    } catch {
      return false;
    }
  }

  private async direct(gen: number): Promise<'ok' | 'denied' | 'failed'> {
    const cur = this.payload;
    if (!cur?.view) return 'failed';
    let res: Response;
    try {
      res = await this.fetchImpl(`${cur.view.url}?after=${cur.cursor}`, {
        headers: { Authorization: `Bearer ${cur.view.token}` },
      });
    } catch {
      return 'failed';
    }
    if (gen !== this.gen) return 'ok';
    if (res.status === 401) return 'denied';
    if (res.status === 403) return 'failed';
    if (!res.ok) return 'ok';
    this.everDirect = true;
    try {
      const body: unknown = await res.json();
      if (gen !== this.gen) return 'ok';
      const parsed = parsePayload(body);
      if (parsed) this.accept(parsed);
    } catch {
      /* ignore a malformed body; the next tick retries */
    }
    return 'ok';
  }

  private async tick(): Promise<void> {
    this.ticking = true;
    try {
      await this.tickOnce();
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    const gen = this.gen;
    if (!this.running || !this.payload) return;
    const settling = this.settle >= 0;
    if (!settling && TERMINAL.has(this.payload.status)) return this.stop();
    if (settling && hidden()) return this.afterSettleRead(); // the wait still counts toward the cap

    let refreshed = false;
    if (this.expiresAt - this.now() < REFRESH_WINDOW_MS) {
      await this.refresh(gen);
      refreshed = true;
    }
    if (gen !== this.gen) return;

    if (this.mode === 'direct') {
      let r = await this.direct(gen);
      if (gen !== this.gen) return;
      if (r === 'denied') {
        const renewed = await this.refresh(gen);
        if (gen !== this.gen) return;
        r = renewed ? await this.direct(gen) : 'failed';
        if (gen !== this.gen) return;
        if (r === 'denied') r = 'failed';
      }
      if (r === 'failed') this.setMode('bridge');
    } else {
      // A failed read (a network blip) must not cost the direct path for good: try it again.
      let back = false;
      if (this.now() - this.probeAt >= DIRECT_RETRY_MS) {
        this.probeAt = this.now();
        back = (await this.direct(gen)) === 'ok';
        if (gen !== this.gen) return;
        if (back) this.setMode('direct');
      }
      if (!back && !refreshed) await this.refresh(gen);
      if (gen !== this.gen) return;
    }

    if (settling) return this.afterSettleRead();
    if (this.payload && TERMINAL.has(this.payload.status)) return this.beginSettle();
    this.schedule();
  }

  /** One read of the saved wait done: stop once `saved` arrived, a newer turn started or the
   * waits ran out; otherwise wait the next, longer step. A newer turn that is still running goes
   * back to the live poll. */
  private afterSettleRead(): void {
    const p = this.payload;
    if (p && !TERMINAL.has(p.status)) {
      this.settle = -1;
      return this.schedule();
    }
    if (!p || !awaitsSaved(p) || (p.turn ?? 1) !== this.settleTurn) return this.stop();
    this.settle++;
    if (this.settle >= SAVED_BACKOFF_MS.length) return this.stop();
    this.schedule();
  }
}
