/**
 * The control view's input, as wire events for the task's browser
 * (POST <issuer>/v1/runs/<id>/browser/input, body {event}). Coordinates are CSS pixels of the remote
 * viewport, whose size is the frame's w×h. The canvas shows the frame letterboxed ("contain").
 */

export type MouseType = 'mouseMoved' | 'mousePressed' | 'mouseReleased';
export type MouseButton = 'left' | 'right' | 'middle' | 'none';
export type BrowserInput =
  | { kind: 'mouse'; type: MouseType; x: number; y: number; button?: MouseButton; clickCount?: number }
  | {
      kind: 'key'; type: 'keyDown' | 'keyUp' | 'char'; text?: string; key?: string; code?: string;
      windowsVirtualKeyCode?: number; commands?: string[];
    }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'paste'; text: string }
  | { kind: 'resize'; width: number; height: number; dpr: number }
  | { kind: 'resume' };

export interface Size { width: number; height: number }
export interface FrameDims { w: number; h: number }
export interface Rect { x: number; y: number; width: number; height: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Where the frame sits in the canvas box: scaled to fit and centred. */
export function containRect(box: Size, frame: FrameDims): Rect {
  if (box.width <= 0 || box.height <= 0 || frame.w <= 0 || frame.h <= 0) return { x: 0, y: 0, width: box.width, height: box.height };
  const k = Math.min(box.width / frame.w, box.height / frame.h);
  const width = frame.w * k;
  const height = frame.h * k;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/**
 * A point in the canvas box (CSS px from its top-left) as a point of the remote viewport. A point in
 * the letterbox bars maps to null, unless `clampOutside` (a release must still reach the page, at
 * the nearest edge).
 */
export function toRemote(px: number, py: number, box: Size, frame: FrameDims, clampOutside = false): { x: number; y: number } | null {
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  const r = containRect(box, frame);
  if (!(r.width > 0) || !(r.height > 0)) return null;
  const lx = px - r.x;
  const ly = py - r.y;
  if ((lx < 0 || ly < 0 || lx > r.width || ly > r.height) && !clampOutside) return null;
  return {
    x: Math.round(clamp((clamp(lx, 0, r.width) / r.width) * frame.w, 0, frame.w - 1)),
    y: Math.round(clamp((clamp(ly, 0, r.height) / r.height) * frame.h, 0, frame.h - 1)),
  };
}

/** DOM MouseEvent.button to the wire's button name. */
export function mouseButton(b: number): MouseButton {
  return b === 0 ? 'left' : b === 1 ? 'middle' : b === 2 ? 'right' : 'none';
}

/** DOM MouseEvent.buttons (a bit mask of held buttons) to the button a move drags with. */
export function heldButton(buttons: number): MouseButton {
  return buttons & 1 ? 'left' : buttons & 2 ? 'right' : buttons & 4 ? 'middle' : 'none';
}

export function mouseInput(type: MouseType, at: { x: number; y: number }, button: MouseButton = 'none', clickCount?: number): BrowserInput {
  const ev: BrowserInput = { kind: 'mouse', type, x: at.x, y: at.y, button };
  if (clickCount !== undefined) ev.clickCount = clamp(Math.trunc(clickCount) || 0, 0, 3);
  return ev;
}

const LINE_PX = 16;
const MAX_DELTA = 5000;

/** A wheel event; `deltaMode` 1 (lines) and 2 (pages) become pixels. */
export function wheelInput(at: { x: number; y: number }, deltaX: number, deltaY: number, deltaMode = 0, pageHeight = 800): BrowserInput {
  const k = deltaMode === 1 ? LINE_PX : deltaMode === 2 ? pageHeight : 1;
  const d = (v: number) => Math.round(clamp((Number.isFinite(v) ? v : 0) * k, -MAX_DELTA, MAX_DELTA));
  return { kind: 'wheel', x: at.x, y: at.y, deltaX: d(deltaX), deltaY: d(deltaY) };
}

/** Non-text keys and their Windows virtual-key codes: without a code the remote page ignores them. */
const VK: Readonly<Record<string, number>> = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

/** Editing shortcuts that become remote editing commands. Paste is not one: see isPasteChord. */
const EDIT: Readonly<Record<string, string>> = { a: 'selectAll', c: 'copy', x: 'cut' };

export interface Mods { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean }

/** Cmd or Ctrl without Alt (Ctrl+Alt is AltGr on some layouts and types a character). */
const editing = (m?: Mods) => !!(m?.ctrl || m?.meta) && !m?.alt;

/** Cmd/Ctrl+V: the remote browser cannot read the user's clipboard, so the card sends the text
 * from the paste event instead and never forwards the chord. */
export function isPasteChord(key: string, m?: Mods): boolean {
  return editing(m) && key.toLowerCase() === 'v';
}

/** A DOM key event as a wire event, or null when nothing is sent. Printable keys go as one `char`
 * on keydown (the keyup is dropped); other keys as keyDown/keyUp with their virtual-key code. */
export function keyInput(domType: 'keydown' | 'keyup', key: string, code: string, m?: Mods): BrowserInput | null {
  if (typeof key !== 'string' || !key || key === 'Unidentified' || key === 'Dead' || key === 'Process') return null;
  const k = key.slice(0, 32);
  const c = (code || '').slice(0, 32);
  const printable = [...key].length === 1;
  if (printable && editing(m)) {
    if (domType !== 'keydown') return null;
    const lower = key.toLowerCase();
    let command: string | undefined;
    if (lower === 'z') command = m?.shift ? 'redo' : 'undo';
    else if (lower === 'y' && m?.ctrl && !m?.meta) command = 'redo';
    else command = EDIT[lower];
    return command ? { kind: 'key', type: 'keyDown', key: k, code: c, commands: [command] } : null;
  }
  if (printable) return domType === 'keydown' ? { kind: 'key', type: 'char', text: key.slice(0, 16) } : null;
  if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta' || key === 'CapsLock') return null;
  const vk = VK[key];
  const ev: BrowserInput = { kind: 'key', type: domType === 'keydown' ? 'keyDown' : 'keyUp', key: k, code: c };
  if (vk !== undefined) ev.windowsVirtualKeyCode = vk;
  // Enter (main or keypad) needs its text on keyDown, or the page never sees the key press that
  // submits a form or starts a new line.
  if (key === 'Enter' && ev.type === 'keyDown') ev.text = '\r';
  return ev;
}

/** Presses this close in time and space count as one double or triple click. */
export const CLICK_MS = 500;
export const CLICK_PX = 4;

/**
 * Click counts from press timing, as the page expects (1, 2, 3, then 1 again). Pointer events do
 * not carry a click count of their own.
 */
export class ClickCounter {
  private last: { button: MouseButton; x: number; y: number; t: number; n: number } | null = null;

  /** A press of `button` at canvas point (x, y), at time `t` (ms): its click count. */
  press(button: MouseButton, x: number, y: number, t: number): number {
    const l = this.last;
    const near = !!l && l.button === button && t - l.t <= CLICK_MS && Math.hypot(x - l.x, y - l.y) <= CLICK_PX;
    const n = near && l!.n < 3 ? l!.n + 1 : 1;
    this.last = { button, x, y, t, n };
    return n;
  }

  /** The count of the latest press (its release carries the same). */
  get count(): number {
    return this.last?.n ?? 1;
  }
}

export const MAX_PASTE = 4000;

/** Paste events for `text`: split into pieces of at most 4000 characters (UTF-16 units, the wire's
 * limit), never inside a character, so nothing is cut off. */
export function pasteInputs(text: string): BrowserInput[] {
  if (typeof text !== 'string' || !text) return [];
  const out: BrowserInput[] = [];
  let piece = '';
  for (const ch of text) {
    if (piece.length + ch.length > MAX_PASTE) {
      out.push({ kind: 'paste', text: piece });
      piece = '';
    }
    piece += ch;
  }
  if (piece) out.push({ kind: 'paste', text: piece });
  return out;
}

/** The remote viewport for a canvas box of w×h CSS px (clamped to 200..4096, dpr 1). */
export function resizeInput(width: number, height: number): BrowserInput {
  const s = (v: number) => clamp(Math.round(Number.isFinite(v) ? v : 0), 200, 4096);
  return { kind: 'resize', width: s(width), height: s(height), dpr: 1 };
}

export type SendResult = 'ok' | 'not_waiting' | 'failed';
/** What one request came to: a result, or "busy" (429, refused before anything was forwarded)
 * with the wait the server asked for. */
export type SendOutcome = SendResult | { retryAfterMs: number };

/** Events that may share one request (typing and pasting); everything else goes alone. */
const batchable = (e: BrowserInput) => e.kind === 'key' || e.kind === 'paste';
export const BATCH_MAX = 32;
/** Bytes of JSON in one batch, well under the server's 64 KB cap. */
const BATCH_BYTES = 32_768;

/**
 * Sends input in order, one request at a time. Typing and pasting queued together go as one
 * request (at most 32 events); a queued mouse move is replaced by a newer one. When the server is
 * busy (429) an event is sent again once after the wait it asks for; a mouse move is dropped
 * instead. Nothing else is resent. Closing drops whatever is still queued. `not_waiting` (someone resumed elsewhere) drops what is queued and is reported once.
 */
export class InputQueue {
  private q: { ev: BrowserInput; done?: (r: SendResult) => void }[] = [];
  private busy = false;
  private closed = false;
  constructor(
    private sendMany: (events: BrowserInput[]) => Promise<SendOutcome>,
    private onNotWaiting: () => void,
    private wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    /** A fire-and-forget event (not a mouse move) could not be sent. */
    private onFailed?: () => void,
  ) {}

  /** Queue an event; fire and forget. */
  push(ev: BrowserInput): void {
    if (this.closed) return;
    const last = this.q[this.q.length - 1];
    const move = (e?: BrowserInput) => e?.kind === 'mouse' && e.type === 'mouseMoved';
    if (move(ev) && last && !last.done && move(last.ev)) last.ev = ev;
    else this.q.push({ ev });
    void this.pump();
  }

  /** Queue an event after everything already queued and resolve with its result. */
  send(ev: BrowserInput): Promise<SendResult> {
    if (this.closed) return Promise.resolve('not_waiting');
    return new Promise((done) => {
      this.q.push({ ev, done });
      void this.pump();
    });
  }

  close(): void {
    this.closed = true;
    const left = this.q;
    this.q = [];
    for (const i of left) i.done?.('not_waiting');
  }

  get pending(): number {
    return this.q.length;
  }

  /** The next request: one event, or consecutive typing/paste events up to the batch limits. */
  private take(): { ev: BrowserInput; done?: (r: SendResult) => void }[] {
    const first = this.q.shift()!;
    const items = [first];
    if (!first.done && batchable(first.ev)) {
      let bytes = JSON.stringify(first.ev).length * 2;
      while (items.length < BATCH_MAX && this.q.length && !this.q[0]!.done && batchable(this.q[0]!.ev)) {
        const size = JSON.stringify(this.q[0]!.ev).length * 2; // UTF-16 length × 2 covers UTF-8
        if (bytes + size > BATCH_BYTES) break;
        bytes += size;
        items.push(this.q.shift()!);
      }
    }
    return items;
  }

  private async attempt(events: BrowserInput[]): Promise<SendResult> {
    const moveOnly = events.length === 1 && events[0]!.kind === 'mouse' && events[0]!.type === 'mouseMoved';
    for (let tries = 0; ; tries++) {
      let out: SendOutcome;
      try {
        out = await this.sendMany(events);
      } catch {
        out = 'failed';
      }
      if (typeof out === 'string') return out;
      if (moveOnly || tries >= 1 || this.closed) return 'failed';
      await this.wait(Math.min(5000, Math.max(0, out.retryAfterMs)));
      if (this.closed) return 'not_waiting';
    }
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.q.length && !this.closed) {
        const items = this.take();
        const r = await this.attempt(items.map((i) => i.ev));
        for (const i of items) i.done?.(r);
        if (r === 'failed' && !this.closed && items.some((i) => !i.done && !(i.ev.kind === 'mouse' && i.ev.type === 'mouseMoved'))) {
          this.onFailed?.();
        }
        if (r === 'not_waiting' && !this.closed) {
          this.close();
          this.onNotWaiting();
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
