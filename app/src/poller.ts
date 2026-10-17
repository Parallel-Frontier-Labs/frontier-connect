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

export class Poller {
  mode: 'direct' | 'bridge' = 'direct';
  private payload: TaskPayload | null = null;
  private expiresAt = Infinity;
  private timer: unknown = null;
  private running = false;
  private gen = 0;
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
  }

  stop(): void {
    this.running = false;
    this.gen++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private waiting(): boolean {
    const s = this.payload?.status;
    return s === 'waiting_for_answer' || s === 'waiting_for_you';
  }

  private interval(): number {
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
    if (TERMINAL.has(this.payload.status)) return this.stop();

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

    if (this.payload && TERMINAL.has(this.payload.status)) return this.stop();
    this.schedule();
  }
}
