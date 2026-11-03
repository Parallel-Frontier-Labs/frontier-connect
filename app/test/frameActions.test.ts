// frontier-connect/app/test/frameActions.test.ts
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAME_ACTIONS, installFrameActions } from '../src/preview/frameActions';
import { FRAME_CSP, FRAME_GUARD, framedHtml } from '../src/preview/frame';

let posted: unknown[] = [];
const realPost = window.postMessage;
let n = 0;

beforeEach(() => {
  posted = [];
  n = 0;
  // jsdom: window.parent === window, so the frame's post lands here.
  window.postMessage = ((m: unknown) => { posted.push(m); }) as typeof window.postMessage;
  document.body.innerHTML = '';
});
afterEach(() => {
  window.postMessage = realPost;
  Object.defineProperty(navigator, 'userActivation', { value: undefined, configurable: true });
});

// jsdom has no object URLs; give the page a working pair BEFORE installing, so the install wraps it
// (a per-test stub would overwrite the wrapper).
URL.createObjectURL = vi.fn(() => `blob:null/${++n}`) as typeof URL.createObjectURL;
URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;

const anchor = (href: string, attrs: Record<string, string> = {}) => {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  a.textContent = 'x';
  document.body.appendChild(a);
  return a;
};
const click = (el: Element) => { const e = new MouseEvent('click', { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };
const until = async () => { await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0)); };

describe('installFrameActions', () => {
  // One install per test file run is enough: the listener and the URL wrapper live on window.
  installFrameActions(window);

  it('posts a relative href as a file action, untouched', () => {
    const e = click(anchor('Book_2026-10.xlsx'));
    expect(e.defaultPrevented).toBe(true);
    expect(posted).toEqual([{ type: 'frontier:frame', v: 1, kind: 'file', href: 'Book_2026-10.xlsx' }]);
  });

  it('posts http(s) as a link with the absolute URL', () => {
    click(anchor('https://example.com/a?b=1'));
    expect(posted).toEqual([{ type: 'frontier:frame', v: 1, kind: 'link', href: 'https://example.com/a?b=1' }]);
  });

  it('leaves in-page anchors alone and swallows other schemes', () => {
    const e = click(anchor('#top'));
    expect(e.defaultPrevented).toBe(false);
    for (const h of ['mailto:a@example.com', 'javascript:void(0)', '//example.com/x', 'tel:123']) {
      expect(click(anchor(h)).defaultPrevented, h).toBe(true);
    }
    expect(posted).toEqual([]);
  });

  it('reads a page-built blob from its own registry (no fetch) and posts the bytes', async () => {
    const url = URL.createObjectURL(new Blob(['a,b'], { type: 'text/csv' }));
    click(anchor(url, { download: 'list.csv' }));
    await until();
    expect(posted).toEqual([{ type: 'frontier:frame', v: 1, kind: 'download', name: 'list.csv', mime: 'text/csv', base64: 'YSxi' }]);
  });

  it('forgets revoked blobs and ignores unknown ones', async () => {
    const url = URL.createObjectURL(new Blob(['x']));
    URL.revokeObjectURL(url);
    click(anchor(url, { download: 'x.txt' }));
    click(anchor('blob:null/never', { download: 'y.txt' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).toEqual([]);
  });

  it('decodes data: URLs, base64 and percent-encoded', () => {
    click(anchor('data:text/csv;base64,YSxi', { download: 'a.csv' }));
    click(anchor('data:text/plain,h%C3%A9', { download: 'b.txt' }));
    expect(posted).toEqual([
      { type: 'frontier:frame', v: 1, kind: 'download', name: 'a.csv', mime: 'text/csv', base64: 'YSxi' },
      { type: 'frontier:frame', v: 1, kind: 'download', name: 'b.txt', mime: 'text/plain', base64: 'aMOp' },
    ]);
  });

  it('posts an empty payload for a file over 10 MB', async () => {
    const big = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]);
    click(anchor(URL.createObjectURL(big), { download: 'big.bin' }));
    await until();
    expect(posted).toEqual([{ type: 'frontier:frame', v: 1, kind: 'download', name: 'big.bin', mime: '', base64: '' }]);
  });

  it('does nothing without user activation (a page cannot fire dialogs on its own)', () => {
    Object.defineProperty(navigator, 'userActivation', { value: { isActive: false }, configurable: true });
    const e = click(anchor('Book.xlsx'));
    expect(e.defaultPrevented).toBe(true); // still never navigates
    expect(posted).toEqual([]);
  });

  it('does not stop the page\'s own anchor handlers', () => {
    const a = anchor('javascript:void(0)');
    let ran = false;
    a.addEventListener('click', () => { ran = true; });
    const e = click(a);
    expect(ran).toBe(true);
    expect(e.defaultPrevented).toBe(true);
  });

  it('handles a detached anchor click (blob download and relative file)', async () => {
    const url = URL.createObjectURL(new Blob(['a,b'], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'list.csv';
    a.click();
    await until();
    expect(posted).toEqual([{ type: 'frontier:frame', v: 1, kind: 'download', name: 'list.csv', mime: 'text/csv', base64: 'YSxi' }]);
    posted = [];
    const f = document.createElement('a');
    f.setAttribute('href', 'Book.xlsx');
    f.click();
    expect(posted).toEqual([{ type: 'frontier:frame', v: 1, kind: 'file', href: 'Book.xlsx' }]);
  });

  it('does nothing for a detached click without user activation', () => {
    Object.defineProperty(navigator, 'userActivation', { value: { isActive: false }, configurable: true });
    const f = document.createElement('a');
    f.setAttribute('href', 'Book.xlsx');
    f.click();
    expect(posted).toEqual([]);
  });

  it('trims hrefs and ignores empty ones', () => {
    expect(click(anchor('')).defaultPrevented).toBe(true);
    expect(click(anchor('   ')).defaultPrevented).toBe(true);
    expect(posted).toEqual([]);
    click(anchor(' https://example.com/x'));
    expect(posted).toEqual([{ type: 'frontier:frame', v: 1, kind: 'link', href: 'https://example.com/x' }]);
    expect(click(anchor(' #top')).defaultPrevented).toBe(false);
  });

  it('detached #x click posts nothing', () => {
    const a = document.createElement('a');
    a.setAttribute('href', '#x');
    a.click();
    expect(posted).toEqual([]);
  });

  it('catches a detached anchor clicked with dispatchEvent', async () => {
    const url = URL.createObjectURL(new Blob(['a,b'], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'list.csv';
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await until();
    expect(posted).toEqual([{ type: 'frontier:frame', v: 1, kind: 'download', name: 'list.csv', mime: 'text/csv', base64: 'YSxi' }]);
  });

  it('respects page cancellation on a detached anchor (click and dispatchEvent)', () => {
    const a = document.createElement('a');
    a.setAttribute('href', 'Book.xlsx');
    a.addEventListener('click', (e) => e.preventDefault());
    a.click();
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(posted).toEqual([]);
  });

  it('respects a page cancel that also stops immediate propagation (detached and non-bubbling)', () => {
    const cancelAndStop = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const detached = document.createElement('a');
    detached.setAttribute('href', 'Book.xlsx');
    detached.addEventListener('click', cancelAndStop);
    detached.click();
    detached.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const connected = anchor('Book.xlsx');
    connected.addEventListener('click', cancelAndStop);
    connected.dispatchEvent(new MouseEvent('click', { cancelable: true }));
    expect(posted).toEqual([]);
  });

  it('still acts when a page stops immediate propagation without cancelling', () => {
    const a = document.createElement('a');
    a.setAttribute('href', 'Book.xlsx');
    a.addEventListener('click', (e) => e.stopImmediatePropagation());
    expect(a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(true);
    expect(posted).toEqual([{ type: 'frontier:frame', v: 1, kind: 'file', href: 'Book.xlsx' }]);
  });

  it('runs page listeners on a detached anchor click()', () => {
    const a = document.createElement('a');
    a.setAttribute('href', 'Book.xlsx');
    let ran = false;
    a.addEventListener('click', () => { ran = true; });
    a.click();
    expect(ran).toBe(true);
    expect(posted.length).toBe(1);
  });

  it('a connected anchor click() posts exactly once', () => {
    anchor('Book.xlsx').click();
    expect(posted.length).toBe(1);
  });

  it('respects a page handler that cancels a connected anchor click', () => {
    const a = anchor('Book.xlsx');
    a.addEventListener('click', (e) => e.preventDefault());
    const e = click(a);
    expect(e.defaultPrevented).toBe(true);
    expect(posted).toEqual([]);
  });

  it('posts the href a page handler set during the click', () => {
    const a = anchor('Book.xlsx');
    a.addEventListener('click', () => { a.href = 'Other.xlsx'; });
    click(a);
    expect(posted).toEqual([{ type: 'frontier:frame', v: 1, kind: 'file', href: 'Other.xlsx' }]);
  });

  it('page handlers see an uncancelled click; navigation is prevented afterwards', () => {
    const a = anchor('Book.xlsx');
    let seen: boolean | null = null;
    a.addEventListener('click', (e) => { seen = e.defaultPrevented; });
    document.body.addEventListener('click', (e) => { if (e.target === a) seen = seen || e.defaultPrevented; });
    const e = click(a);
    expect(seen).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(posted).toEqual([{ type: 'frontier:frame', v: 1, kind: 'file', href: 'Book.xlsx' }]);
  });

  it('posts nothing when a page handler stops propagation (the sandbox blocks the navigation)', () => {
    const a = anchor('https://example.com/x');
    // preventDefault too, only so jsdom does not attempt (and log) the navigation a browser's sandbox blocks.
    a.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
    click(a);
    expect(posted).toEqual([]);
  });

  it('handles a non-bubbling click dispatched on a connected anchor exactly once', () => {
    const e1 = new MouseEvent('click', { cancelable: true });
    anchor('Book.xlsx').dispatchEvent(e1);
    expect(e1.defaultPrevented).toBe(true);
    expect(posted).toEqual([{ type: 'frontier:frame', v: 1, kind: 'file', href: 'Book.xlsx' }]);
    posted = [];
    anchor('Other.xlsx').dispatchEvent(new MouseEvent('click'));
    expect(posted).toEqual([{ type: 'frontier:frame', v: 1, kind: 'file', href: 'Other.xlsx' }]);
  });

  it('respects page cancellation of a non-bubbling click on a connected anchor', () => {
    const a = anchor('Book.xlsx');
    a.addEventListener('click', (e) => e.preventDefault());
    a.dispatchEvent(new MouseEvent('click', { cancelable: true }));
    expect(posted).toEqual([]);
  });

  it('handles a bubbling click dispatched on a connected anchor exactly once', () => {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor('Book.xlsx').dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(posted.length).toBe(1);
  });

  it('finds an anchor inside an open shadow root', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const a = document.createElement('a');
    a.setAttribute('href', 'Book.xlsx');
    a.textContent = 'x';
    host.attachShadow({ mode: 'open' }).appendChild(a);
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
    a.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(posted).toEqual([{ type: 'frontier:frame', v: 1, kind: 'file', href: 'Book.xlsx' }]);
  });
});

describe('FRAME_ACTIONS and framedHtml', () => {
  it('is one self-contained script that runs on its own', () => {
    expect(FRAME_ACTIONS.startsWith('<script>(')).toBe(true);
    expect(FRAME_ACTIONS.endsWith(')(window)</script>')).toBe(true);
    expect(FRAME_ACTIONS.slice(8, -9)).not.toContain('</script');
    expect(FRAME_ACTIONS).not.toMatch(/\b__\w+\(/); // no bundler helper calls
  });
  it('works when evaluated from the serialised text, in a fresh window', () => {
    const dom = new JSDOM('<a id="f" href="Book.xlsx">x</a>', { runScripts: 'outside-only' });
    const w = dom.window as unknown as Window & typeof globalThis;
    const got: unknown[] = [];
    w.postMessage = ((m: unknown) => { got.push(m); }) as typeof w.postMessage;
    w.URL.createObjectURL = (() => 'blob:null/1') as typeof w.URL.createObjectURL;
    w.URL.revokeObjectURL = (() => {}) as typeof w.URL.revokeObjectURL;
    new Function('window', FRAME_ACTIONS.slice('<script>'.length, -'</script>'.length))(w);
    w.document.getElementById('f')!.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(got).toEqual([{ type: 'frontier:frame', v: 1, kind: 'file', href: 'Book.xlsx' }]);
    got.length = 0;
    const d = w.document.createElement('a');
    d.setAttribute('href', 'Other.xlsx');
    d.click();
    expect(got).toEqual([{ type: 'frontier:frame', v: 1, kind: 'file', href: 'Other.xlsx' }]);
    got.length = 0;
    const e = w.document.createElement('a');
    e.setAttribute('href', 'Third.xlsx');
    e.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(got).toEqual([{ type: 'frontier:frame', v: 1, kind: 'file', href: 'Third.xlsx' }]);
  });
  it('comes after the CSP and the guard, before the page', () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">${FRAME_GUARD}${FRAME_ACTIONS}`;
    expect(framedHtml('<!doctype html><p>x')).toBe(`<!doctype html>${meta}<p>x`);
  });
});
