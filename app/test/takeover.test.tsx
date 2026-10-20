import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserFrame } from '../src/browserFeed';
import type { BrowserInput, SendOutcome, SendResult } from '../src/browserInput';
import type { TaskPayload } from '../src/types';
import type { BrowserApi, FeedHandle } from '../src/view/BrowserPreview';
import {
  CONTROL_HINT, ELSEWHERE_FORM, ELSEWHERE_HOST, ESC_HINT, FORM_TITLE, RECONNECTING, SEND_FAILED_NOTE, inlineHeight, RESUME_FAILED, signInTitle, STOP_FAILED, TAKEOVER_FALLBACK, takeoverText,
} from '../src/view/BrowserTakeover';
import { Card } from '../src/view/Card';

const mk = (o: Partial<TaskPayload> = {}): TaskPayload => ({
  task_id: 't', status: 'waiting_for_you', title: 'Console check', plan: [{ title: 'Open the console', status: 'in_progress' }],
  sections: [], live: null, estimate: null, open_ask: null, deliverables: [], result: null, work_ms: 0, usage: null,
  events: [{ seq: 4, kind: 'takeover', text: 'Sign in to the console, then resume.' }], cursor: 4, more: false,
  browser: { state: 'waiting', site: 'app.example.com' }, ...o,
});
const fr = (o: Partial<BrowserFrame> = {}): BrowserFrame => ({ seq: 1, awaiting: true, site: null, w: 1280, h: 800, data: 'AAAA', at: 1, ...o });

/** A scripted card environment: display mode answers, input results, a frame feed the test drives. */
function env(o: { grant?: boolean; input?: (ev: BrowserInput) => Promise<SendResult>; container?: { maxHeight?: number } } = {}) {
  const sent: BrowserInput[] = [];
  let push: (f: BrowserFrame | null) => void = () => {};
  const handle: FeedHandle = { start: vi.fn(), stop: vi.fn(), setMode: vi.fn(), setVisible: vi.fn(), wake: vi.fn() };
  let mode = 'inline';
  const refresh = vi.fn();
  const api = (): BrowserApi => ({
    modes: ['inline', 'fullscreen'],
    mode,
    feed: vi.fn((onFrame) => { push = onFrame; return handle; }),
    requestDisplayMode: requests,
    input: inputs,
    refresh,
    container: () => o.container,
  });
  const requests = vi.fn(async (m: 'inline' | 'fullscreen') => {
    if (m === 'inline' || o.grant) mode = m;
    return mode;
  });
  const batches: BrowserInput[][] = [];
  const taskIds: string[] = [];
  const inputs = vi.fn(async (taskId: string, evs: BrowserInput[]): Promise<SendOutcome> => {
    taskIds.push(taskId);
    batches.push(evs);
    sent.push(...evs);
    for (const ev of evs) {
      const r = o.input ? await o.input(ev) : 'ok';
      if (r !== 'ok') return r;
    }
    return 'ok';
  });
  return { api, sent, batches, taskIds, refresh, handle, requests, inputs, push: (f: BrowserFrame | null) => push(f), setMode: (m: string) => (mode = m), mode: () => mode };
}

// jsdom has no pointer events: declare the handler properties browsers have, so Preact listens for
// the lower-case event names as it does in a browser.
for (const n of ['onpointerdown', 'onpointerup', 'onpointermove', 'onpointercancel', 'onlostpointercapture']) {
  if (!(n in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, n, { value: null, writable: true, configurable: true });
}

/** jsdom has no PointerEvent: a MouseEvent of the pointer type carries the same fields. */
const ptr = (el: Element, type: string, init: MouseEventInit) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));

let rafs: (() => void)[] = [];
const flushRaf = () => { const q = rafs; rafs = []; q.forEach((f) => f()); };
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

beforeEach(() => {
  rafs = [];
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => { rafs.push(f); return rafs.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function takeOver(e: ReturnType<typeof env>, payload = mk()) {
  const r = render(<Card payload={payload} browser={e.api()} />);
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Take over' })); await tick(); });
  r.rerender(<Card payload={payload} browser={e.api()} />);
  return r;
}

describe('sign-in panel', () => {
  it('shows when the task waits for the user in its browser', () => {
    const e = env();
    const { getByRole, getByText, container } = render(<Card payload={mk()} browser={e.api()} />);
    const panel = getByRole('region', { name: 'Sign in to app.example.com' });
    expect(panel.textContent).toContain('Sign in to the console, then resume.');
    getByRole('button', { name: 'Take over' });
    getByRole('button', { name: 'Take over the browser' });
    expect(getByRole('region', { name: 'Browser, paused' }).querySelector('.fc-bv-live')!.textContent).toBe('Paused');
    getByText('Click the preview to take over');
    expect(container.querySelector('.fc-mini')).not.toBeNull(); // the paused steps
  });

  it('titles and text fall back when the site or the takeover line is unknown', () => {
    expect(signInTitle(null)).toBe('The browser needs you');
    expect(signInTitle('a.io')).toBe('Sign in to a.io');
    expect(takeoverText(mk({ events: [] }))).toBe(TAKEOVER_FALLBACK);
    expect(takeoverText(mk({ events: [{ seq: 1, kind: 'takeover', text: 'old' }, { seq: 2, kind: 'narration', text: 'x' }, { seq: 3, kind: 'takeover', text: ' new ' }] }))).toBe('new');
    const { getByRole } = render(<Card payload={mk({ browser: { state: 'waiting', site: null } })} browser={env().api()} />);
    getByRole('region', { name: 'The browser needs you' });
  });

  it('hides Stop task unless the card may stop the task', () => {
    const e = env();
    const { queryByRole, rerender } = render(<Card payload={mk()} browser={e.api()} />);
    expect(queryByRole('button', { name: 'Stop task' })).toBeNull();
    const stop = vi.fn(async () => true);
    rerender(<Card payload={mk()} browser={{ ...e.api(), stop }} />);
    fireEvent.click(queryByRole('button', { name: 'Stop task' })!);
    expect(stop).toHaveBeenCalled();
  });

  it.each([
    ['browser live', { browser: { state: 'live', site: 'a.io' } }],
    ['no browser', { browser: null }],
    ['waiting for an answer', { status: 'waiting_for_answer' }],
    ['running', { status: 'running', browser: { state: 'waiting', site: 'a.io' } }],
  ] as const)('not shown: %s', (_n, o) => {
    const { queryByRole } = render(<Card payload={mk(o as Partial<TaskPayload>)} browser={env().api()} />);
    expect(queryByRole('button', { name: 'Take over' })).toBeNull();
  });

  it('not shown when the card cannot send input', () => {
    const { queryByRole } = render(<Card payload={mk()} browser={{ ...env().api(), input: undefined }} />);
    expect(queryByRole('button', { name: 'Take over' })).toBeNull();
  });

  it('an open question still comes first', () => {
    const ask = { ask_id: 'a1', kind: 'question' as const, questions: [{ id: 'q', kind: 'confirm', prompt: 'Proceed?' }] };
    const { queryByRole } = render(<Card payload={mk({ open_ask: ask })} browser={env().api()} />);
    expect(queryByRole('button', { name: 'Take over' })).toBeNull();
  });
});

describe('entering and leaving the control view', () => {
  it('Take over asks for full screen and, when granted, fills the frame', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    expect(e.requests).toHaveBeenCalledWith('fullscreen');
    const view = r.getByRole('region', { name: 'Frontier browser panel' });
    expect(view.className).toBe('fc-ctl fc-ctl-full');
    expect(r.container.querySelector('article')!.className).toContain('fc-card-full');
    expect(r.getByText(CONTROL_HINT)).toBeTruthy();
    r.getByRole('button', { name: 'Done, resume task' });
    r.getByRole('button', { name: 'Close the panel' });
    r.getByRole('button', { name: 'Paste' });
    expect(e.handle.setMode).toHaveBeenCalledWith('control');
  });

  it('when the host refuses, the control view opens inline, as tall as the host allows', async () => {
    const e = env({ grant: false, container: { maxHeight: 600 } });
    const r = await takeOver(e);
    const view = r.getByRole('region', { name: 'Frontier browser panel' });
    expect(view.className).toBe('fc-ctl');
    expect((r.container.querySelector('.fc-ctl-stage') as HTMLElement).style.height).toBe(`${600 - 176}px`);
    expect(inlineHeight(undefined)).toBe(640);
    expect(inlineHeight({ maxHeight: 2000 })).toBe(640);
    expect(inlineHeight({ height: 300 })).toBe(200);
  });

  it('clicking the paused preview is Take over', async () => {
    const e = env({ grant: true });
    const r = render(<Card payload={mk()} browser={e.api()} />);
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Take over the browser' })); await tick(); });
    expect(e.requests).toHaveBeenCalledWith('fullscreen');
    r.getByRole('region', { name: 'Frontier browser panel' });
  });

  it('focuses the canvas (tabindex 0) on entering control', async () => {
    const r = await takeOver(env({ grant: true }));
    const canvas = r.container.querySelector('canvas')!;
    expect(canvas.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(canvas);
  });

  it('the host leaving full screen on its own returns to the card', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    e.setMode('inline');
    r.rerender(<Card payload={mk()} browser={e.api()} />);
    expect(r.queryByRole('region', { name: 'Frontier browser panel' })).toBeNull();
    r.getByRole('button', { name: 'Take over' });
  });

  it('close × asks for inline and leaves; the task stays waiting', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Close the panel' })); await tick(); });
    expect(e.requests).toHaveBeenLastCalledWith('inline');
    expect(e.sent.some((ev) => ev.kind === 'resume')).toBe(false);
    r.rerender(<Card payload={mk()} browser={e.api()} />);
    r.getByRole('button', { name: 'Take over' });
  });

  it('Done, resume: posts resume, then asks for inline, and says it is resuming', async () => {
    const e = env({ grant: true });
    const order: string[] = [];
    e.inputs.mockImplementation(async (_t, evs) => { for (const ev of evs) order.push(`input:${ev.kind}`); e.sent.push(...evs); return 'ok'; });
    e.requests.mockImplementation(async (m) => { order.push(`mode:${m}`); e.setMode(m); return m; });
    const r = await takeOver(e);
    order.length = 0;
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Done, resume task' })); await tick(); });
    expect(order.filter((x) => x !== 'input:resize')).toEqual(['input:resume', 'mode:inline']);
    expect(e.refresh).toHaveBeenCalledTimes(1); // the Poller reads the task at once
    r.rerender(<Card payload={mk()} browser={e.api()} />);
    expect(r.getByRole('status').textContent).toBe('Resuming the task…');
    // The task runs again: back to the step list and the live preview.
    r.rerender(<Card payload={mk({ status: 'running', browser: { state: 'live', site: 'app.example.com' } })} browser={e.api()} />);
    r.getByRole('region', { name: 'Browser, live' });
    expect(r.container.querySelector('.fc-timeline')).not.toBeNull();
  });

  it('a failed resume says so and stays in control', async () => {
    const e = env({ grant: true, input: async (ev) => (ev.kind === 'resume' ? 'failed' : 'ok') });
    const r = await takeOver(e);
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Done, resume task' })); await tick(); });
    expect(r.getByRole('alert').textContent).toBe(RESUME_FAILED);
    r.getByRole('region', { name: 'Frontier browser panel' });
    expect(e.requests).not.toHaveBeenCalledWith('inline');
  });

  it('409 not_waiting on any input leaves the control view quietly', async () => {
    const e = env({ grant: true, input: async (ev) => (ev.kind === 'key' ? 'not_waiting' : 'ok') });
    const r = await takeOver(e);
    const canvas = r.container.querySelector('canvas')!;
    await act(async () => { fireEvent.keyDown(canvas, { key: 'a', code: 'KeyA' }); await tick(); });
    expect(r.queryByRole('region', { name: 'Frontier browser panel' })).toBeNull();
    expect(r.queryByRole('alert')).toBeNull();
    expect(e.requests).toHaveBeenLastCalledWith('inline');
  });

  it('the task resumed elsewhere (status running) leaves control and returns to the preview', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    await act(async () => {
      r.rerender(<Card payload={mk({ status: 'running', browser: { state: 'live', site: 'app.example.com' } })} browser={e.api()} />);
      await tick();
    });
    expect(e.requests).toHaveBeenLastCalledWith('inline');
    r.rerender(<Card payload={mk({ status: 'running', browser: { state: 'live', site: 'app.example.com' } })} browser={e.api()} />);
    expect(r.queryByRole('region', { name: 'Frontier browser panel' })).toBeNull();
    r.getByRole('region', { name: 'Browser, live' });
  });
});

describe('input in the control view', () => {
  function sized(canvas: HTMLCanvasElement, w = 640, h = 400) {
    canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: w, height: h, right: 10 + w, bottom: 20 + h, x: 10, y: 20, toJSON: () => ({}) }) as DOMRect;
  }

  it('sends resize once per size change (rAF-coalesced)', async () => {
    let cb: () => void = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(f: () => void) { cb = f; } observe() {} disconnect() {} });
    const e = env({ grant: true });
    const r = await takeOver(e);
    const stage = r.container.querySelector('.fc-ctl-stage') as HTMLElement;
    let w = 900;
    let h = 560;
    Object.defineProperty(stage, 'clientWidth', { get: () => w });
    Object.defineProperty(stage, 'clientHeight', { get: () => h });
    cb(); cb(); cb();
    await act(async () => { flushRaf(); await tick(); });
    cb();
    await act(async () => { flushRaf(); await tick(); }); // same size: nothing new
    w = 1000;
    cb();
    await act(async () => { flushRaf(); await tick(); });
    expect(e.sent.filter((ev) => ev.kind === 'resize')).toEqual([
      { kind: 'resize', width: 900, height: 560, dpr: 1 },
      { kind: 'resize', width: 1000, height: 560, dpr: 1 },
    ]);
    h = 0; // collapsed: nothing
    cb();
    await act(async () => { flushRaf(); await tick(); });
    expect(e.sent.filter((ev) => ev.kind === 'resize')).toHaveLength(2);
  });

  it('maps clicks through the letterbox; the card counts double clicks itself (pointer detail is 0)', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    act(() => e.push(fr()));
    const canvas = r.container.querySelector('canvas')!;
    sized(canvas);
    await act(async () => {
      for (let i = 0; i < 2; i++) {
        ptr(canvas, 'pointerdown', { clientX: 330, clientY: 220, button: 0, detail: 0 });
        ptr(canvas, 'pointerup', { clientX: 331, clientY: 220, button: 0, detail: 0 });
      }
      await tick();
    });
    expect(e.sent.filter((ev) => ev.kind === 'mouse')).toEqual([
      { kind: 'mouse', type: 'mousePressed', x: 640, y: 400, button: 'left', clickCount: 1 },
      { kind: 'mouse', type: 'mouseReleased', x: 642, y: 400, button: 'left', clickCount: 1 },
      { kind: 'mouse', type: 'mousePressed', x: 640, y: 400, button: 'left', clickCount: 2 },
      { kind: 'mouse', type: 'mouseReleased', x: 642, y: 400, button: 'left', clickCount: 2 },
    ]);
  });

  it('a cancelled drag releases the held button where it was', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    act(() => e.push(fr()));
    const canvas = r.container.querySelector('canvas')!;
    sized(canvas);
    await act(async () => {
      ptr(canvas, 'pointerdown', { clientX: 330, clientY: 220, button: 0 });
      ptr(canvas, 'pointermove', { clientX: 340, clientY: 220, buttons: 1 });
      canvas.dispatchEvent(new Event('pointercancel', { bubbles: true }));
      canvas.dispatchEvent(new Event('lostpointercapture', { bubbles: true })); // nothing more held
      await tick();
    });
    const mouse = e.sent.filter((ev) => ev.kind === 'mouse' && ev.type !== 'mouseMoved');
    expect(mouse).toEqual([
      { kind: 'mouse', type: 'mousePressed', x: 640, y: 400, button: 'left', clickCount: 1 },
      { kind: 'mouse', type: 'mouseReleased', x: 660, y: 400, button: 'left', clickCount: 1 },
    ]);
  });

  it('throttles mouse moves to one per animation frame', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    act(() => e.push(fr()));
    const canvas = r.container.querySelector('canvas')!;
    sized(canvas);
    ptr(canvas, 'pointermove', { clientX: 20, clientY: 30, buttons: 0 });
    ptr(canvas, 'pointermove', { clientX: 40, clientY: 30, buttons: 0 });
    ptr(canvas, 'pointermove', { clientX: 60, clientY: 30, buttons: 1 });
    await act(async () => { flushRaf(); await tick(); });
    const moves = e.sent.filter((ev) => ev.kind === 'mouse');
    expect(moves).toEqual([{ kind: 'mouse', type: 'mouseMoved', x: 100, y: 20, button: 'left' }]);
  });

  it('wheel scrolls at the pointer', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    act(() => e.push(fr()));
    const canvas = r.container.querySelector('canvas')!;
    sized(canvas);
    await act(async () => { fireEvent.wheel(canvas, { clientX: 10, clientY: 20, deltaY: 240 }); await tick(); });
    // A point in the letterbox (none here: the box has the frame's aspect) or outside sends nothing.
    await act(async () => { fireEvent.wheel(canvas, { clientX: 5, clientY: 20, deltaY: 1 }); await tick(); });
    expect(e.sent.filter((ev) => ev.kind === 'wheel')).toEqual([{ kind: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: 240 }]);
  });

  it('typing: printable keys as char, special keys down/up, Cmd/Ctrl+V never forwarded, paste sends the text', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    const canvas = r.container.querySelector('canvas')!;
    await act(async () => {
      fireEvent.keyDown(canvas, { key: 'h', code: 'KeyH' });
      fireEvent.keyUp(canvas, { key: 'h', code: 'KeyH' });
      fireEvent.keyDown(canvas, { key: 'Enter', code: 'Enter' });
      fireEvent.keyUp(canvas, { key: 'Enter', code: 'Enter' });
      fireEvent.keyDown(canvas, { key: 'v', code: 'KeyV', ctrlKey: true });
      fireEvent.keyUp(canvas, { key: 'v', code: 'KeyV', ctrlKey: true });
      const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
      paste.clipboardData = { getData: (t: string) => (t === 'text/plain' ? 's3cret' : '') };
      canvas.dispatchEvent(paste);
      await tick();
    });
    expect(e.sent.filter((ev) => ev.kind !== 'resize')).toEqual([
      { kind: 'key', type: 'char', text: 'h' },
      { kind: 'key', type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      { kind: 'key', type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
      { kind: 'paste', text: 's3cret' },
    ]);
  });

  it('Escape moves focus to Done instead of trapping the keyboard', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    const canvas = r.container.querySelector('canvas')!;
    await act(async () => { fireEvent.keyDown(canvas, { key: 'Escape', code: 'Escape' }); await tick(); });
    expect(document.activeElement).toBe(r.getByRole('button', { name: 'Done, resume task' }));
    expect(e.sent.some((ev) => ev.kind === 'key')).toBe(false);
  });

  it('the Paste button opens a field and sends its text', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    fireEvent.click(r.getByRole('button', { name: 'Paste' }));
    const field = r.getByLabelText('Text to paste') as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    fireEvent.input(field, { target: { value: 'pw-123' } });
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Send' })); await tick(); });
    expect(e.sent.filter((ev) => ev.kind === 'paste')).toEqual([{ kind: 'paste', text: 'pw-123' }]);
    expect(r.queryByLabelText('Text to paste')).toBeNull();
    expect(document.activeElement).toBe(r.container.querySelector('canvas'));
  });

  it('adds no keyboard listeners to the window or document', async () => {
    const w = vi.spyOn(window, 'addEventListener');
    const d = vi.spyOn(document, 'addEventListener');
    const r = await takeOver(env({ grant: true }));
    fireEvent.click(r.getByRole('button', { name: 'Paste' }));
    const types = [...w.mock.calls, ...d.mock.calls].map((c) => String(c[0]));
    expect(types.filter((t) => /^key|paste/.test(t))).toEqual([]);
  });

  it('a long paste is sent whole, in pieces of at most 4000', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    const canvas = r.container.querySelector('canvas')!;
    await act(async () => {
      const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
      paste.clipboardData = { getData: () => 'q'.repeat(9001) };
      canvas.dispatchEvent(paste);
      await tick();
    });
    const parts = e.sent.filter((ev) => ev.kind === 'paste') as { text: string }[];
    expect(parts.map((p) => p.text.length)).toEqual([4000, 4000, 1001]);
  });

  it('typing queued behind a request goes as one batch', async () => {
    let release!: () => void;
    const e = env({ grant: true });
    const r = await takeOver(e);
    e.inputs.mockImplementation(async (_t, evs) => { e.batches.push(evs); e.sent.push(...evs); await new Promise<void>((res) => (release = res)); return 'ok'; });
    const canvas = r.container.querySelector('canvas')!;
    await act(async () => {
      fireEvent.keyDown(canvas, { key: 'p', code: 'KeyP' });
      fireEvent.keyDown(canvas, { key: 'w', code: 'KeyW' });
      fireEvent.keyDown(canvas, { key: 'Enter', code: 'Enter' });
      fireEvent.keyUp(canvas, { key: 'Enter', code: 'Enter' });
      await tick();
      release();
      await tick();
      release();
      await tick();
    });
    const keyBatches = e.batches.filter((b) => b.every((ev) => ev.kind === 'key'));
    expect(keyBatches.map((b) => b.length)).toEqual([1, 3]);
  });
});

describe('fix round', () => {
  it('the paused preview has a button over the picture, not around it (no blocks in a button)', () => {
    const { container } = render(<Card payload={mk()} browser={env().api()} />);
    const take = container.querySelector('.fc-bv-take')!;
    expect(take.tagName).toBe('BUTTON');
    expect(take.children).toHaveLength(0);
    expect(container.querySelectorAll('button div, button p, button canvas')).toHaveLength(0);
  });

  it('shows a visible Escape hint in the footer', async () => {
    const r = await takeOver(env({ grant: true }));
    expect(r.container.querySelector('.fc-ctl-foot')!.textContent).toContain(ESC_HINT);
    expect(ESC_HINT).toBe('Esc leaves the browser');
  });

  it('returns focus to Take over after closing the control view', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Close the panel' })); await tick(); });
    r.rerender(<Card payload={mk()} browser={e.api()} />);
    await act(async () => { await tick(); });
    expect(document.activeElement).toBe(r.getByRole('button', { name: 'Take over' }));
  });

  it('focuses the card when the panel is gone after leaving', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    const running = mk({ status: 'running', browser: { state: 'live', site: 'a.io' } });
    await act(async () => { r.rerender(<Card payload={running} browser={e.api()} />); await tick(); });
    expect(document.activeElement).toBe(r.container.querySelector('article'));
  });

  it('a host that does not answer the full-screen request within 3 s gets the inline view', async () => {
    vi.useFakeTimers();
    try {
      const e = env();
      e.requests.mockImplementation((m) => (m === 'fullscreen' ? new Promise(() => {}) : Promise.resolve('inline')));
      const r = render(<Card payload={mk()} browser={e.api()} />);
      fireEvent.click(r.getByRole('button', { name: 'Take over' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(2900); });
      expect(r.queryByRole('region', { name: 'Frontier browser panel' })).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(r.getByRole('region', { name: 'Frontier browser panel' }).className).toBe('fc-ctl');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a new takeover after a resume shows the panel again', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Done, resume task' })); await tick(); });
    r.rerender(<Card payload={mk()} browser={e.api()} />);
    expect(r.queryByRole('button', { name: 'Take over' })).toBeNull();
    const again = mk({ events: [{ seq: 9, kind: 'takeover', text: 'Sign in again.' }], cursor: 9 });
    r.rerender(<Card payload={again} browser={e.api()} />);
    r.getByRole('button', { name: 'Take over' });
  });

  it('Stop task calls the card stop and says so when it fails', async () => {
    const e = env();
    const stop = vi.fn(async () => false);
    const r = render(<Card payload={mk()} browser={{ ...e.api(), stop }} />);
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Stop task' })); await tick(); });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(r.getByRole('alert').textContent).toBe(STOP_FAILED);
  });

});

describe('waits the card cannot take over', () => {
  it('a host without the direct path: no Take over, the panel says to use Frontier', () => {
    const e = env();
    const stop = vi.fn(async () => true);
    const { queryByRole, getByRole, container } = render(<Card payload={mk()} browser={{ ...e.api(), transport: () => 'blocked', stop }} />);
    const panel = getByRole('region', { name: 'Sign in to app.example.com' });
    expect(panel.textContent).toContain(ELSEWHERE_HOST);
    expect(queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(queryByRole('button', { name: 'Take over the browser' })).toBeNull();
    expect(container.querySelector('.fc-bv')).toBeNull(); // no dead preview either
    getByRole('button', { name: 'Stop task' });
    expect(e.handle.start).not.toHaveBeenCalled();
  });

  it('transport direct or absent keeps Take over', () => {
    const e = env();
    const a = render(<Card payload={mk()} browser={{ ...e.api(), transport: () => 'direct' }} />);
    expect((a.getByRole('button', { name: 'Take over' }) as HTMLButtonElement).disabled).toBe(false);
    a.unmount();
    const b = render(<Card payload={mk()} browser={{ ...e.api(), transport: undefined }} />);
    b.getByRole('button', { name: 'Take over' });
  });

  it('a direct path that dropped after working: Take over waits, "Reconnecting…", not "continue in Frontier"', () => {
    const e = env();
    const { getByRole, queryByText, rerender } = render(<Card payload={mk()} browser={{ ...e.api(), transport: () => 'reconnecting' }} />);
    expect((getByRole('button', { name: 'Take over' }) as HTMLButtonElement).disabled).toBe(true);
    expect((getByRole('button', { name: 'Take over the browser' }) as HTMLButtonElement).disabled).toBe(true);
    expect(getByRole('status').textContent).toBe(RECONNECTING);
    expect(queryByText(ELSEWHERE_HOST)).toBeNull();
    rerender(<Card payload={mk()} browser={{ ...e.api(), transport: () => 'direct' }} />);
    expect((getByRole('button', { name: 'Take over' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a form in the task browser is not a sign-in: no Take over, continue in Frontier', () => {
    const e = env();
    const p = mk({ browser: { state: 'waiting', site: 'crm.example.com', form: true } });
    const { queryByRole, getByRole } = render(<Card payload={p} browser={e.api()} />);
    const panel = getByRole('region', { name: FORM_TITLE });
    expect(panel.textContent).toContain(ELSEWHERE_FORM);
    expect(queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(queryByRole('button', { name: 'Take over the browser' })).toBeNull();
  });

  it('a form wait with an open form ask shows the form', () => {
    const e = env();
    const ask = {
      ask_id: 'f1', kind: 'form' as const,
      form: { title: 'Details', sections: [{ id: 's', fields: [{ id: 'n', kind: 'short_text' as const, label: 'Name', options: [] }] }] },
    };
    const p = mk({ browser: { state: 'waiting', site: null, form: true }, open_ask: ask });
    const { queryByRole, getByLabelText } = render(<Card payload={p} browser={e.api()} />);
    getByLabelText(/Name/);
    expect(queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(queryByRole('region', { name: FORM_TITLE })).toBeNull();
  });

});

describe('input stays with its task', () => {
  it('every request names the task the control view opened for', async () => {
    const e = env({ grant: true });
    const r = await takeOver(e);
    await act(async () => { fireEvent.keyDown(r.container.querySelector('canvas')!, { key: 'a', code: 'KeyA' }); await tick(); });
    expect(new Set(e.taskIds)).toEqual(new Set(['t']));
  });

  it('typing still queued when the view goes away is dropped, never sent', async () => {
    let release!: (o: SendOutcome) => void;
    const e = env({ grant: true });
    const r = await takeOver(e);
    e.inputs.mockImplementation(async (_t, evs) => { e.sent.push(...evs); return new Promise<SendOutcome>((res) => (release = res)); });
    const canvas = r.container.querySelector('canvas')!;
    await act(async () => {
      fireEvent.keyDown(canvas, { key: 'Enter', code: 'Enter' }); // in flight
      fireEvent.keyDown(canvas, { key: 'p', code: 'KeyP' });       // queued behind it
      fireEvent.keyDown(canvas, { key: 'w', code: 'KeyW' });
      await tick();
    });
    const before = e.sent.length;
    r.unmount();
    await act(async () => { release('ok'); await tick(); });
    expect(e.sent.length).toBe(before);
    expect(e.sent.some((ev) => ev.kind === 'key' && ev.type === 'char')).toBe(false);
  });

  it('a send that fails says so briefly', async () => {
    const e = env({ grant: true, input: async (ev) => (ev.kind === 'key' ? 'failed' : 'ok') });
    const r = await takeOver(e);
    await act(async () => { fireEvent.keyDown(r.container.querySelector('canvas')!, { key: 'a', code: 'KeyA' }); await tick(); });
    expect(r.getByText(SEND_FAILED_NOTE).getAttribute('role')).toBe('status');
  });
});

