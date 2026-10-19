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
}

const REFRESH_WINDOW_MS = 120_000;
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

  constructor(o: PollerOptions) {
    this.bridge = o.bridge;
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
    this.now = o.now ?? Date.now;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onUpdate = o.onUpdate;
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
      this.mode = 'direct';
    }
    this.accept(p);
    if (!TERMINAL.has(p.status)) this.schedule();
    else this.beginSettle();
  }

  stop(): void {
    this.running = false;
    this.settle = -1;
    this.gen++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
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
      if (r === 'failed') this.mode = 'bridge';
    } else {
      if (!refreshed) await this.refresh(gen);
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
