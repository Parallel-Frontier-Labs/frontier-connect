import { describe, expect, it, vi } from 'vitest';
import {
  BATCH_MAX, ClickCounter, CLICK_MS, containRect, heldButton, InputQueue, isPasteChord, keyInput, MAX_PASTE, mouseButton, mouseInput, pasteInputs, resizeInput,
  toRemote, wheelInput, type BrowserInput, type SendOutcome, type SendResult,
} from '../src/browserInput';

const frame = { w: 1280, h: 800 };

describe('mapping the canvas to the remote viewport', () => {
  it('scales a point of a same-aspect box', () => {
    expect(toRemote(320, 200, { width: 640, height: 400 }, frame)).toEqual({ x: 640, y: 400 });
    expect(toRemote(0, 0, { width: 640, height: 400 }, frame)).toEqual({ x: 0, y: 0 });
    expect(toRemote(640, 400, { width: 640, height: 400 }, frame)).toEqual({ x: 1279, y: 799 });
  });

  it('accounts for the letterbox bars of a box with another aspect', () => {
    // 800x400 box: the frame is drawn 640x400, centred, bars of 80 px left and right.
    expect(containRect({ width: 800, height: 400 }, frame)).toEqual({ x: 80, y: 0, width: 640, height: 400 });
    expect(toRemote(80, 0, { width: 800, height: 400 }, frame)).toEqual({ x: 0, y: 0 });
    expect(toRemote(400, 200, { width: 800, height: 400 }, frame)).toEqual({ x: 640, y: 400 });
  });

  it('a point in the bars maps to nothing, unless clamped (a release reaches the nearest edge)', () => {
    expect(toRemote(10, 200, { width: 800, height: 400 }, frame)).toBeNull();
    expect(toRemote(10, 200, { width: 800, height: 400 }, frame, true)).toEqual({ x: 0, y: 400 });
    expect(toRemote(900, -5, { width: 800, height: 400 }, frame, true)).toEqual({ x: 1279, y: 0 });
    expect(toRemote(10, 10, { width: 0, height: 0 }, frame)).toBeNull();
    expect(toRemote(NaN, 10, { width: 640, height: 400 }, frame)).toBeNull();
    expect(toRemote(undefined as unknown as number, 10, { width: 640, height: 400 }, frame, true)).toBeNull();
  });

  it('maps DOM buttons', () => {
    expect([0, 1, 2, 3].map(mouseButton)).toEqual(['left', 'middle', 'right', 'none']);
    expect([0, 1, 2, 4, 3].map(heldButton)).toEqual(['none', 'left', 'right', 'middle', 'left']);
  });

  it('builds mouse events with a click count of 0..3', () => {
    expect(mouseInput('mousePressed', { x: 1, y: 2 }, 'left', 2)).toEqual({ kind: 'mouse', type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 2 });
    expect(mouseInput('mousePressed', { x: 1, y: 2 }, 'left', 7)).toMatchObject({ clickCount: 3 });
    expect(mouseInput('mouseMoved', { x: 1, y: 2 })).toEqual({ kind: 'mouse', type: 'mouseMoved', x: 1, y: 2, button: 'none' });
  });

  it('wheel deltas become pixels and are clamped to ±5000', () => {
    expect(wheelInput({ x: 5, y: 6 }, 0, 120)).toEqual({ kind: 'wheel', x: 5, y: 6, deltaX: 0, deltaY: 120 });
    expect(wheelInput({ x: 5, y: 6 }, 2, 3, 1)).toMatchObject({ deltaX: 32, deltaY: 48 });
    expect(wheelInput({ x: 5, y: 6 }, 0, 1, 2, 800)).toMatchObject({ deltaY: 800 });
    expect(wheelInput({ x: 5, y: 6 }, -99999, 99999)).toMatchObject({ deltaX: -5000, deltaY: 5000 });
    expect(wheelInput({ x: 5, y: 6 }, NaN, 1.6)).toMatchObject({ deltaX: 0, deltaY: 2 });
  });
});

describe('keys', () => {
  it('a printable key is one char on keydown; its keyup sends nothing', () => {
    expect(keyInput('keydown', 'a', 'KeyA')).toEqual({ kind: 'key', type: 'char', text: 'a' });
    expect(keyInput('keydown', 'É', 'KeyE', { shift: true })).toEqual({ kind: 'key', type: 'char', text: 'É' });
    expect(keyInput('keydown', ' ', 'Space')).toEqual({ kind: 'key', type: 'char', text: ' ' });
    expect(keyInput('keyup', 'a', 'KeyA')).toBeNull();
  });

  it('special keys are keyDown and keyUp with their virtual-key code', () => {
    // Enter carries "\r" on keyDown so the page submits the form or starts a new line.
    expect(keyInput('keydown', 'Enter', 'Enter')).toEqual({ kind: 'key', type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    expect(keyInput('keyup', 'Enter', 'Enter')).toEqual({ kind: 'key', type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    expect(keyInput('keydown', 'Enter', 'NumpadEnter')).toMatchObject({ type: 'keyDown', code: 'NumpadEnter', text: '\r' });
    expect(keyInput('keydown', 'Tab', 'Tab')).not.toHaveProperty('text');
    for (const [k, vk] of [['Backspace', 8], ['Tab', 9], ['ArrowLeft', 37], ['ArrowDown', 40], ['Delete', 46], ['Home', 36], ['F5', 116]] as const) {
      expect(keyInput('keydown', k, k)).toMatchObject({ type: 'keyDown', windowsVirtualKeyCode: vk });
    }
    expect(keyInput('keydown', 'MediaPlayPause', 'MediaPlayPause')).toEqual({ kind: 'key', type: 'keyDown', key: 'MediaPlayPause', code: 'MediaPlayPause' });
  });

  it('modifier keys alone and composition placeholders send nothing', () => {
    for (const k of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified', 'Process', '']) expect(keyInput('keydown', k, k)).toBeNull();
  });

  it('editing shortcuts become commands; other chords send nothing; AltGr types', () => {
    expect(keyInput('keydown', 'a', 'KeyA', { meta: true })).toEqual({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', commands: ['selectAll'] });
    expect(keyInput('keydown', 'c', 'KeyC', { ctrl: true })).toMatchObject({ commands: ['copy'] });
    expect(keyInput('keydown', 'z', 'KeyZ', { ctrl: true })).toMatchObject({ commands: ['undo'] });
    expect(keyInput('keydown', 'z', 'KeyZ', { meta: true, shift: true })).toMatchObject({ commands: ['redo'] });
    expect(keyInput('keydown', 'y', 'KeyY', { ctrl: true })).toMatchObject({ commands: ['redo'] });
    expect(keyInput('keyup', 'a', 'KeyA', { meta: true })).toBeNull();
    expect(keyInput('keydown', 't', 'KeyT', { ctrl: true })).toBeNull();
    expect(keyInput('keydown', '@', 'KeyQ', { ctrl: true, alt: true })).toEqual({ kind: 'key', type: 'char', text: '@' });
  });

  it('Cmd/Ctrl+V is the paste chord and is never forwarded', () => {
    expect(isPasteChord('v', { meta: true })).toBe(true);
    expect(isPasteChord('V', { ctrl: true, shift: true })).toBe(true);
    expect(isPasteChord('v', { ctrl: true, alt: true })).toBe(false);
    expect(isPasteChord('v', {})).toBe(false);
    expect(keyInput('keydown', 'v', 'KeyV', { ctrl: true })).toBeNull();
  });

  it('caps key fields', () => {
    const ev = keyInput('keydown', 'K'.repeat(40), 'C'.repeat(40)) as Extract<BrowserInput, { kind: 'key' }>;
    expect(ev.key!.length).toBe(32);
    expect(ev.code!.length).toBe(32);
  });
});

describe('paste and resize', () => {
  it('paste is split into pieces of at most 4000, never inside a character, nothing lost', () => {
    expect(pasteInputs('hunter2')).toEqual([{ kind: 'paste', text: 'hunter2' }]);
    const long = 'x'.repeat(9000);
    const parts = pasteInputs(long) as { text: string }[];
    expect(parts.map((x) => x.text.length)).toEqual([4000, 4000, 1000]);
    expect(parts.map((x) => x.text).join('')).toBe(long);
    // An emoji (two UTF-16 units) straddling the limit moves whole into the next piece.
    const edge = 'a'.repeat(MAX_PASTE - 1) + '😀' + 'b';
    const e = pasteInputs(edge) as { text: string }[];
    expect(e.map((x) => x.text.length)).toEqual([MAX_PASTE - 1, 3]);
    expect(e[1]!.text).toBe('😀b');
    expect(e.map((x) => x.text).join('')).toBe(edge);
    expect(pasteInputs('')).toEqual([]);
  });

  it('resize is clamped to 200..4096 at dpr 1', () => {
    expect(resizeInput(812.4, 503.6)).toEqual({ kind: 'resize', width: 812, height: 504, dpr: 1 });
    expect(resizeInput(50, 9000)).toEqual({ kind: 'resize', width: 200, height: 4096, dpr: 1 });
  });
});

describe('ClickCounter', () => {
  it('counts presses close in time and space as double and triple clicks, then starts over', () => {
    const c = new ClickCounter();
    expect(c.press('left', 10, 10, 0)).toBe(1);
    expect(c.press('left', 12, 11, 200)).toBe(2);
    expect(c.press('left', 12, 12, 400)).toBe(3);
    expect(c.count).toBe(3);
    expect(c.press('left', 12, 12, 600)).toBe(1); // after a triple: a new single
    expect(c.press('left', 12, 12, 600 + CLICK_MS + 1)).toBe(1); // too slow
    expect(c.press('left', 30, 12, 1300)).toBe(1); // too far
    expect(c.press('right', 30, 12, 1400)).toBe(1); // another button
    expect(c.press('right', 33, 14, 1500)).toBe(2);
  });
});

describe('InputQueue', () => {
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  it('sends one event at a time, in order', async () => {
    const sent: BrowserInput[] = [];
    let release!: () => void;
    const send = vi.fn((evs: BrowserInput[]) => { sent.push(...evs); return new Promise<SendOutcome>((r) => (release = () => r('ok'))); });
    const q = new InputQueue(send, () => {});
    q.push(mouseInput('mousePressed', { x: 1, y: 1 }, 'left', 1));
    q.push(mouseInput('mouseReleased', { x: 1, y: 1 }, 'left', 1));
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(sent.map((e) => (e as { type: string }).type)).toEqual(['mousePressed', 'mouseReleased']);
  });

  it('a queued mouse move is replaced by a newer one', async () => {
    const sent: BrowserInput[] = [];
    let release!: () => void;
    const q = new InputQueue((evs) => { sent.push(...evs); return new Promise<SendOutcome>((r) => (release = () => r('ok'))); }, () => {});
    q.push({ kind: 'paste', text: 'first' });
    for (let x = 1; x <= 5; x++) q.push(mouseInput('mouseMoved', { x, y: 0 }));
    expect(q.pending).toBe(1);
    release();
    await flush();
    release();
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ type: 'mouseMoved', x: 5 });
  });

  it('send() resolves with the result after what was queued before it', async () => {
    const order: string[] = [];
    const q = new InputQueue(async (evs) => { order.push(...evs.map((e) => e.kind)); return 'ok'; }, () => {});
    q.push({ kind: 'paste', text: 'pw' });
    expect(await q.send({ kind: 'resume' })).toBe('ok');
    expect(order).toEqual(['paste', 'resume']);
  });

  it('not_waiting drops the queue and is reported once', async () => {
    const onNotWaiting = vi.fn();
    const send = vi.fn(async (_e: BrowserInput[]): Promise<SendOutcome> => 'not_waiting');
    const q = new InputQueue(send, onNotWaiting);
    q.push({ kind: 'paste', text: 'a' });
    const later = q.send({ kind: 'resume' });
    expect(await later).toBe('not_waiting');
    expect(send).toHaveBeenCalledTimes(1);
    expect(onNotWaiting).toHaveBeenCalledTimes(1);
    q.push({ kind: 'paste', text: 'b' });
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a failed or throwing send does not stop the queue', async () => {
    const results: SendResult[] = ['failed'];
    const send = vi.fn(async (_e: BrowserInput[]): Promise<SendOutcome> => { if (send.mock.calls.length === 2) throw new Error('x'); return results.shift() ?? 'ok'; });
    const q = new InputQueue(send, () => {});
    q.push(mouseInput('mousePressed', { x: 1, y: 1 }, 'left', 1));
    q.push(mouseInput('mouseReleased', { x: 1, y: 1 }, 'left', 1));
    expect(await q.send({ kind: 'resume' })).toBe('ok');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('typing and pasting queued together go as one request of at most 32, in order; others alone', async () => {
    const calls: BrowserInput[][] = [];
    let release!: () => void;
    const q = new InputQueue((evs) => { calls.push(evs); return new Promise<SendOutcome>((r) => (release = () => r('ok'))); }, () => {});
    q.push(mouseInput('mousePressed', { x: 1, y: 1 }, 'left', 1)); // goes at once, alone
    for (let i = 0; i < 40; i++) q.push({ kind: 'key', type: 'char', text: String(i % 10) });
    q.push({ kind: 'paste', text: 'pw' });
    q.push(mouseInput('mouseReleased', { x: 1, y: 1 }, 'left', 1));
    const resume = q.send({ kind: 'resume' });
    for (let i = 0; i < 6; i++) { await flush(); release(); }
    await resume;
    expect(calls.map((c) => c.length)).toEqual([1, BATCH_MAX, 9, 1, 1]);
    expect(BATCH_MAX).toBe(32);
    expect(calls[2]!.at(-1)).toEqual({ kind: 'paste', text: 'pw' });
    expect(calls[4]).toEqual([{ kind: 'resume' }]);
    const typed = calls.slice(1, 3).flat().filter((e) => e.kind === 'key').map((e) => (e as { text: string }).text).join('');
    expect(typed).toBe(Array.from({ length: 40 }, (_, i) => String(i % 10)).join(''));
  });

  it('a big paste is split across requests by size', async () => {
    const calls: BrowserInput[][] = [];
    let release!: () => void;
    const q = new InputQueue((evs) => { calls.push(evs); return new Promise<SendOutcome>((r) => (release = () => r('ok'))); }, () => {});
    q.push(mouseInput('mousePressed', { x: 1, y: 1 }, 'left', 1));
    for (const ev of pasteInputs('z'.repeat(40_000))) q.push(ev);
    for (let i = 0; i < 6; i++) { await flush(); release(); }
    const sizes = calls.slice(1).map((c) => JSON.stringify({ events: c }).length);
    expect(sizes.every((n) => n < 32_768)).toBe(true);
    expect(calls.slice(1).flat().map((e) => (e as { text: string }).text).join('')).toBe('z'.repeat(40_000));
  });

  it('when busy, an event is sent again once after the wait; a mouse move is dropped', async () => {
    const waits: number[] = [];
    const outs: SendOutcome[] = [{ retryAfterMs: 1000 }, 'ok', { retryAfterMs: 1000 }, { retryAfterMs: 2000 }, { retryAfterMs: 1000 }];
    const calls: BrowserInput[][] = [];
    const q = new InputQueue(async (evs) => { calls.push(evs); return outs.shift() ?? 'ok'; }, () => {}, async (ms) => { waits.push(ms); });
    expect(await q.send({ kind: 'paste', text: 'a' })).toBe('ok'); // busy, waited, sent again
    expect(await q.send({ kind: 'paste', text: 'b' })).toBe('failed'); // busy twice: given up
    q.push(mouseInput('mouseMoved', { x: 1, y: 1 }));
    expect(await q.send({ kind: 'resume' })).toBe('ok');
    expect(waits).toEqual([1000, 1000]);
    expect(calls.map((c) => c[0]!.kind)).toEqual(['paste', 'paste', 'paste', 'paste', 'mouse', 'resume']);
  });

  it('reports a failed typing or click once per request; failed moves are silent; closing drops the rest', async () => {
    const onFailed = vi.fn();
    let release!: (r: SendOutcome) => void;
    const calls: BrowserInput[][] = [];
    const q = new InputQueue((evs) => { calls.push(evs); return new Promise<SendOutcome>((r) => (release = r)); }, () => {}, async () => {}, onFailed);
    q.push(mouseInput('mouseMoved', { x: 1, y: 1 }));
    await flush();
    release('failed');
    await flush();
    expect(onFailed).not.toHaveBeenCalled();
    q.push({ kind: 'paste', text: 'a' });
    await flush();
    release('failed');
    await flush();
    expect(onFailed).toHaveBeenCalledTimes(1);
    q.push(mouseInput('mousePressed', { x: 1, y: 1 }, 'left', 1));
    q.push({ kind: 'key', type: 'char', text: 's' });
    q.push({ kind: 'key', type: 'char', text: 'e' });
    await flush();
    q.close(); // the view went away while the press was in flight
    release('ok');
    await flush();
    expect(calls).toHaveLength(3); // the typed characters were dropped, never sent
  });
});

