import { afterEach, describe, expect, it, vi } from 'vitest';
import { kindOf, MAX_PREVIEW_BYTES } from '../src/preview/kind';
import { loadViewer } from '../src/preview/loader';
import { fetchFileBytes } from '../src/preview/fetchFile';

afterEach(() => { document.querySelectorAll('script[data-viewer]').forEach((n) => n.remove()); delete document.documentElement.dataset.static; delete (window as any).__frontierViewers; vi.unstubAllGlobals(); });

describe('kindOf', () => {
  it('maps extensions, case-insensitively', () => {
    expect(['a.XLSX', 'b.csv', 'c.tsv', 'd.xlsm', 'e.xls', 'f.ods', 'g.xlsb', 'h.numbers', 'i.fods'].map(kindOf)).toEqual(Array(9).fill('sheet'));
    expect(['dash.html', 'r.HTM'].map(kindOf)).toEqual(['html', 'html']);
    expect(['a.ofx', 'b.qfx', 'c.qbo', 'd.iif', 'e.txf', 'f.sql', 'g.py', 'h.css'].map(kindOf)).toEqual(Array(8).fill('text'));
    expect(['a.bmp', 'b.avif'].map(kindOf)).toEqual(['image', 'image']);
    expect(kindOf('x.pdf')).toBe('pdf');
    expect(kindOf('x.docx')).toBe('docx');
    expect(kindOf('notes.md')).toBe('markdown');
    expect(['a.txt', 'b.json', 'c.log', 'd.yml'].map(kindOf)).toEqual(Array(4).fill('text'));
    expect(['a.png', 'b.JPG', 'c.webp'].map(kindOf)).toEqual(Array(3).fill('image'));
    expect(['deck.pptx', 'Makefile', 'x.doc', 'x.svg', 'x.heic', 'x.tiff'].map(kindOf)).toEqual(Array(6).fill('none'));
  });
  it('ignores inherited object properties', () => {
    expect(['x.constructor', 'x.toString', 'x.__proto__', 'x.hasOwnProperty'].map(kindOf)).toEqual(Array(4).fill('none'));
  });
  it('has the 25 MB cap', () => expect(MAX_PREVIEW_BYTES).toBe(25 * 1024 * 1024));
});

describe('loadViewer', () => {
  it('rejects when the static base was never filled in', async () => {
    await expect(loadViewer('sheet')).rejects.toThrow('viewer unavailable');
  });
  it('adds one script per viewer from the static base and resolves once it registers', async () => {
    document.documentElement.dataset.static = 'https://api.example.com/v1/connect/static';
    vi.stubGlobal('__VIEWER_FILES__', { sheet: 'viewer-sheet.0123456789ab.js', pdf: 'p.js', docx: 'd.js' });
    const p1 = loadViewer('sheet');
    const p2 = loadViewer('sheet');
    const s = document.querySelectorAll('script[data-viewer="sheet"]');
    expect(s.length).toBe(1);
    expect((s[0] as HTMLScriptElement).src).toBe('https://api.example.com/v1/connect/static/viewer-sheet.0123456789ab.js');
    const impl = { parse: () => [] };
    (window as any).__frontierViewers = { sheet: impl };
    s[0].dispatchEvent(new Event('load'));
    expect(await p1).toBe(impl);
    expect(await p2).toBe(impl);
  });
  it('rejects on a script error, and a later call tries again', async () => {
    document.documentElement.dataset.static = 'https://api.example.com/v1/connect/static';
    vi.stubGlobal('__VIEWER_FILES__', { sheet: 's.js', pdf: 'pdf.js', docx: 'd.js' });
    const p = loadViewer('pdf');
    document.querySelector('script[data-viewer="pdf"]')!.dispatchEvent(new Event('error'));
    await expect(p).rejects.toThrow('viewer unavailable');
    expect(document.querySelectorAll('script[data-viewer="pdf"]').length).toBe(0); // the failed tag was removed
    const again = loadViewer('pdf', { timeoutMs: 5 });
    expect(document.querySelectorAll('script[data-viewer="pdf"]').length).toBe(1);
    await expect(again).rejects.toThrow('viewer unavailable');
  });
  it('rejects after timeoutMs and removes the tag', async () => {
    document.documentElement.dataset.static = 'https://api.example.com/v1/connect/static';
    vi.stubGlobal('__VIEWER_FILES__', { sheet: 's.js', pdf: 'pdf.js', docx: 'd.js' });
    await expect(loadViewer('docx', { timeoutMs: 10 })).rejects.toThrow('viewer unavailable');
    expect(document.querySelectorAll('script[data-viewer="docx"]').length).toBe(0);
  });
  it('rejects when the script loads but registers no viewer', async () => {
    document.documentElement.dataset.static = 'https://api.example.com/v1/connect/static';
    vi.stubGlobal('__VIEWER_FILES__', { sheet: 's.js', pdf: 'pdf.js', docx: 'd.js' });
    const p = loadViewer('docx', { timeoutMs: 1000 });
    document.querySelector('script[data-viewer="docx"]')!.dispatchEvent(new Event('load'));
    await expect(p).rejects.toThrow('viewer unavailable');
    expect(document.querySelectorAll('script[data-viewer="docx"]').length).toBe(0);
  });
});

describe('fetchFileBytes', () => {
  const base = 'https://api.example.com/v1/connect/static';
  const link = (url: string) => async () => ({ kind: 'ok' as const, url, name: 'a.pdf' });
  it('fetches same-origin links without following redirects', async () => {
    document.documentElement.dataset.static = base;
    const f = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Length': '3' } }));
    const r = await fetchFileBytes(link('https://api.example.com/v1/files/b/k/a.pdf?X-Amz-Signature=s'), 'a.pdf', f as unknown as typeof fetch);
    expect(r).toEqual({ kind: 'ok', bytes: new Uint8Array([1, 2, 3]) });
    expect((f.mock.calls[0] as any)[1]).toMatchObject({ redirect: 'error' });
  });
  it('refuses other origins, oversized files, failed links and HTTP errors', async () => {
    document.documentElement.dataset.static = base;
    const never = vi.fn();
    expect(await fetchFileBytes(link('https://elsewhere.example/a.pdf'), 'a.pdf', never as unknown as typeof fetch)).toEqual({ kind: 'failed', message: "Couldn't open this file here." });
    expect(never).not.toHaveBeenCalled();
    const big = vi.fn(async () => new Response('x', { headers: { 'Content-Length': String(25 * 1024 * 1024 + 1) } }));
    expect(await fetchFileBytes(link('https://api.example.com/v1/files/x'), 'a.pdf', big as unknown as typeof fetch)).toEqual({ kind: 'too_large' });
    expect(await fetchFileBytes(async () => ({ kind: 'failed', message: 'No link.' }), 'a.pdf', never as unknown as typeof fetch)).toEqual({ kind: 'failed', message: 'No link.' });
    const e403 = vi.fn(async () => new Response('', { status: 403 }));
    expect(await fetchFileBytes(link('https://api.example.com/v1/files/x'), 'a.pdf', e403 as unknown as typeof fetch)).toEqual({ kind: 'failed', message: "Couldn't load this file. Try again." });
  });
  const stream = (chunks: Uint8Array[], cancel: () => void) => {
    let i = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]!); else c.close(); },
      cancel,
    }));
  };
  it('stops reading a headerless body once it passes the cap, and cancels it', async () => {
    document.documentElement.dataset.static = base;
    const cancel = vi.fn();
    const chunk = new Uint8Array(10 * 1024 * 1024);
    const f = vi.fn(async () => stream([chunk, chunk, chunk, chunk], cancel));
    expect(await fetchFileBytes(link('https://api.example.com/v1/files/x'), 'a.pdf', f as unknown as typeof fetch)).toEqual({ kind: 'too_large' });
    expect(cancel).toHaveBeenCalled();
  });
  it('cancels the body unread when Content-Length is over the cap', async () => {
    document.documentElement.dataset.static = base;
    const cancel = vi.fn();
    const pull = vi.fn((c: ReadableStreamDefaultController<Uint8Array>) => c.enqueue(new Uint8Array(1024)));
    const big = String(25 * 1024 * 1024 + 1);
    const f = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), { headers: { 'Content-Length': big } }));
    expect(await fetchFileBytes(link('https://api.example.com/v1/files/x'), 'a.pdf', f as unknown as typeof fetch)).toEqual({ kind: 'too_large' });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    // A body whose cancel fails is still reported as too large.
    const bad = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel: () => { throw new Error('x'); } }), { headers: { 'Content-Length': big } }));
    expect(await fetchFileBytes(link('https://api.example.com/v1/files/x'), 'a.pdf', bad as unknown as typeof fetch)).toEqual({ kind: 'too_large' });
  });
  it('joins a headerless streamed body under the cap', async () => {
    document.documentElement.dataset.static = base;
    const f = vi.fn(async () => stream([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])], () => {}));
    expect(await fetchFileBytes(link('https://api.example.com/v1/files/x'), 'a.pdf', f as unknown as typeof fetch)).toEqual({ kind: 'ok', bytes: new Uint8Array([1, 2, 3, 4, 5]) });
  });
  it('reports a rejected fetch (what a redirect produces) as failed', async () => {
    document.documentElement.dataset.static = base;
    const f = vi.fn(async () => { throw new TypeError('redirect'); });
    expect(await fetchFileBytes(link('https://api.example.com/v1/files/x'), 'a.pdf', f as unknown as typeof fetch)).toEqual({ kind: 'failed', message: "Couldn't load this file. Try again." });
  });
});
