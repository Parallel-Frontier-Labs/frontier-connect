// frontier-connect/app/src/preview/frameActions.ts
/**
 * Runs inside the HTML preview frame, before the page's own scripts (spec 2026-11-02 §4). In
 * `sandbox="allow-scripts"` under FRAME_CSP a link cannot navigate, open a window or download, so this
 * catches anchor clicks and posts one message to the card, which acts with the host's capabilities.
 *
 * It listens in the bubble phase on window, registered before any page script, so it runs after every
 * page listener on the path (window is the last stop): a page that cancels a click (SPA routing,
 * `return false`) posts nothing, an href rewritten during the click is read as rewritten, and page
 * handlers see `defaultPrevented` exactly as they would without us. The one exception: page listeners
 * registered on `window` itself run after ours, so their cancel is not honoured (inherent: the default
 * must be prevented synchronously, before the event ends). A page that stops propagation
 * means we never see the click; its navigation is then blocked by the sandbox and the card's
 * `frame-src 'none'`, so it fails closed. A page-built anchor never added to the document is caught
 * by wrapping click() and dispatchEvent (below), as is a non-bubbling click dispatched on a connected
 * anchor (FileSaver style), which never reaches window.
 *
 * It is serialised with Function.prototype.toString into FRAME_ACTIONS: it must reference NOTHING
 * outside its own body (no imports, no module constants, no object spread, which a bundler may lower
 * to a helper). frameActions.test.ts runs the serialised copy to prove it.
 *
 * The CSP blocks fetch(blob:), so URL.createObjectURL is wrapped to remember each Blob the page makes.
 * It acts only during user activation so a well-behaved page cannot open dialogs on load or on a timer.
 * This is not a security boundary (page script can post the same messages itself): the card validates
 * every message and checks activation on its own side.
 */
export function installFrameActions(w: Window & typeof globalThis): void {
  const MAX = 10 * 1024 * 1024;
  const blobs = new Map<string, Blob>();
  const U = w.URL;
  const create = U.createObjectURL.bind(U);
  const revoke = U.revokeObjectURL.bind(U);
  U.createObjectURL = function (o: Blob | MediaSource): string {
    const u = create(o);
    if (o instanceof w.Blob) blobs.set(u, o as Blob);
    return u;
  };
  U.revokeObjectURL = function (u: string): void {
    blobs.delete(u);
    revoke(u);
  };
  const post = (kind: string, a: string, b?: string, c?: string) => {
    const m: Record<string, unknown> = { type: 'frontier:frame', v: 1, kind: kind };
    if (kind === 'download') { m.name = a; m.mime = b; m.base64 = c; } else { m.href = a; }
    try { w.parent.postMessage(m, '*'); } catch (_e) { /* the card is gone */ }
  };
  const active = () => {
    const ua = (w.navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    return !ua || ua.isActive !== false;
  };
  const toB64 = (bytes: Uint8Array) => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
    return w.btoa(s);
  };
  const nameOf = (a: HTMLAnchorElement, raw: string) => {
    const dl = a.getAttribute('download');
    if (dl) return dl;
    if (/^data:/i.test(raw)) return 'download';
    const seg = (raw.split('/').pop() || '').split(/[?#]/)[0];
    return seg || 'download';
  };
  const hrefOf = (a: HTMLAnchorElement, raw: string) => (typeof a.href === 'string' && a.href ? a.href : raw);
  const handle = (a: HTMLAnchorElement) => {
    if (!active()) return;
    const raw = (a.getAttribute('href') || '').trim();
    if (!raw || raw.charAt(0) === '#') return;
    if (/^blob:/i.test(raw)) {
      const blob = blobs.get(hrefOf(a, raw)) || blobs.get(raw);
      if (!blob) return;
      const name = nameOf(a, raw);
      if (blob.size > MAX) { post('download', name, blob.type || '', ''); return; }
      const fr = new w.FileReader();
      fr.onload = () => {
        const s = String(fr.result || '');
        const comma = s.indexOf(',');
        post('download', name, blob.type || '', comma >= 0 ? s.slice(comma + 1) : '');
      };
      fr.readAsDataURL(blob);
      return;
    }
    if (/^data:/i.test(raw)) {
      const comma = raw.indexOf(',');
      if (comma < 0) return;
      const meta = raw.slice(5, comma);
      const body = raw.slice(comma + 1);
      const mime = (meta.split(';')[0] || '').trim();
      let b64 = '';
      try {
        b64 = /;base64$/i.test(meta) ? body.replace(/\s+/g, '') : toB64(new w.TextEncoder().encode(decodeURIComponent(body)));
      } catch (_e) { return; }
      post('download', nameOf(a, raw), mime, (b64.length * 3) / 4 > MAX ? '' : b64);
      return;
    }
    if (/^https?:/i.test(raw)) { post('link', hrefOf(a, raw)); return; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.indexOf('//') === 0) return;
    post('file', raw);
  };
  // A page often builds a link, never adds it to the document and calls click(): no event reaches the
  // window listener below, so handle that here. A connected anchor takes the native path: its click
  // bubbles to window and the listener posts it once.
  const origClick = w.HTMLAnchorElement.prototype.click;
  const origDispatch = w.HTMLAnchorElement.prototype.dispatchEvent;
  w.HTMLAnchorElement.prototype.dispatchEvent = function (this: HTMLAnchorElement, ev: Event): boolean {
    // A bubbling click on a connected anchor reaches the window listener; handle it there, once.
    if (!ev || ev.type !== 'click' || (this.isConnected && ev.bubbles)) return origDispatch.call(this, ev);
    // Detached or non-bubbling (never reaches window): our listener runs after the page's own, notes whether it cancelled, then stops the navigation.
    // A page listener that calls stopImmediatePropagation() keeps `last` from running: then the
    // event's own defaultPrevented says whether the page cancelled.
    let ran = false;
    let cancelled = false;
    const last = (e: Event) => { ran = true; cancelled = e.defaultPrevented; e.preventDefault(); };
    this.addEventListener('click', last);
    try { origDispatch.call(this, ev); } finally { this.removeEventListener('click', last); }
    if (!ran) cancelled = ev.defaultPrevented;
    if (!cancelled) handle(this);
    return !cancelled;
  };
  w.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
    if (this.isConnected) { origClick.call(this); return; }
    this.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  w.addEventListener('click', (e: Event) => {
    let a: HTMLAnchorElement | null = null;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (let i = 0; i < path.length && !a; i++) {
      const n = path[i] as Element;
      if (n && n.nodeType === 1 && typeof n.matches === 'function' && n.matches('a[href]')) a = n as HTMLAnchorElement;
    }
    if (!a) {
      const t = e.target as Element | null;
      a = t && typeof t.closest === 'function' ? (t.closest('a[href]') as HTMLAnchorElement | null) : null;
    }
    if (!a) return;
    // Read now: page handlers that ran before us may have rewritten it.
    if ((a.getAttribute('href') || '').trim().charAt(0) === '#') return;
    if (e.defaultPrevented) return; // the page cancelled its own click
    e.preventDefault();
    handle(a);
  });
}

export const FRAME_ACTIONS = `<script>(${installFrameActions.toString()})(window)</script>`;
