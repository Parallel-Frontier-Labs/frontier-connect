import { describe, expect, it, vi } from 'vitest';
import type { PickedFile } from '../src/upload/manifest';
import { listPages, parseTicketUrl, sendFiles } from '../src/upload/transfer';
import { LIST_PAGE_BYTES } from '../src/upload/manifest';

const ORIGIN = 'https://api.example.com';
const TICKET = `${ORIGIN}/v1/connect/t#${'A'.repeat(43)}`;
const pf = (path: string, size: number): PickedFile => ({ path, size, mime: 'application/pdf', blob: new Blob([new Uint8Array(size)]), explicit: true });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const OFF_ORIGIN = 'Frontier sent an upload link the card cannot use; open the task in Frontier';
const BAD_PLAN = 'Frontier sent an unusable upload plan; try again';

function server(opts: { manifest?: (b: any) => Response; put?: (url: string, init: RequestInit) => Response } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const u = String(url);
    if (u.endsWith('/v1/connect/t/list') || u.endsWith('/v1/connect/t/list/done')) return json({ detail: 'Not Found' }, 404); // an older backend
    if (u.endsWith('/v1/connect/t/files')) return json({ task_id: 't1', files: [] });
    calls.push({ url: u, init });
    if (u.endsWith('/v1/connect/t/manifest')) {
      const body = JSON.parse(String(init.body));
      return opts.manifest ? opts.manifest(body) : json({
        uploads: body.files.map((f: any) => f.size > 10
          ? { path: f.path, headers: { 'Content-Type': f.mime }, parts: [{ n: 1, size: 10, put_url: `${ORIGIN}/v1/files/b/k/p1?X-Amz-Signature=s` }, { n: 2, size: f.size - 10, put_url: `${ORIGIN}/v1/files/b/k/p2?X-Amz-Signature=s` }] }
          : { path: f.path, headers: { 'Content-Type': f.mime }, put_url: `${ORIGIN}/v1/files/b/k/${encodeURIComponent(f.path)}?X-Amz-Signature=s` }),
        skipped: [] });
    }
    if (u.endsWith('/v1/connect/t/complete')) {
      const body = JSON.parse(String(init.body));
      return json({ completed: body.complete, failed: [] });
    }
    return opts.put ? opts.put(u, init) : new Response(null, { status: 200 });
  });
  return { calls, fetch: fetchImpl as unknown as typeof fetch };
}

describe('parseTicketUrl', () => {
  it('takes the origin and the fragment secret', () => {
    expect(parseTicketUrl(TICKET)).toEqual({ origin: ORIGIN, raw: 'A'.repeat(43) });
    for (const bad of ['', 'http://api.example.com/v1/connect/t#' + 'A'.repeat(43), `${ORIGIN}/v1/connect/t`, `${ORIGIN}/x#${'A'.repeat(43)}`]) {
      expect(parseTicketUrl(bad), bad).toBeNull();
    }
  });
});

describe('sendFiles', () => {
  it('sends a manifest of explicit files with the ticket in the header, then PUTs each file', async () => {
    const s = server();
    const r = await sendFiles([pf('a.pdf', 3), pf('b/c.pdf', 4)], { fetch: s.fetch, ticket: async () => ({ kind: 'ok', url: TICKET }) });
    expect(r).toEqual({ sent: ['a.pdf', 'b/c.pdf'], failed: [], skipped: [], error: null });
    const man = s.calls[0];
    expect((man.init.headers as Record<string, string>).Authorization).toBe(`Ticket ${'A'.repeat(43)}`);
    expect(JSON.parse(String(man.init.body))).toEqual({ multipart: true, files: [
      { path: 'a.pdf', size: 3, mime: 'application/pdf', explicit: true },
      { path: 'b/c.pdf', size: 4, mime: 'application/pdf', explicit: true }] });
    const puts = s.calls.filter((c) => c.init.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect((puts[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/pdf');
    expect(s.calls.some((c) => c.url.endsWith('/complete'))).toBe(false); // no multipart, no complete
  });

  it('sends a multipart file part by part and completes it', async () => {
    const s = server();
    const r = await sendFiles([pf('big.pdf', 25)], { fetch: s.fetch, ticket: async () => ({ kind: 'ok', url: TICKET }) });
    expect(r.sent).toEqual(['big.pdf']);
    const puts = s.calls.filter((c) => c.init.method === 'PUT');
    expect(puts.map((p) => (p.init.body as Blob).size)).toEqual([10, 15]);
    const done = s.calls.find((c) => c.url.endsWith('/complete'))!;
    expect(JSON.parse(String(done.init.body))).toEqual({ complete: ['big.pdf'], abort: [] });
  });

  it('retries a failed PUT once, then reports the file without stopping the others', async () => {
    let n = 0;
    const s = server({ put: (u) => (u.includes('bad') ? (n++, new Response(null, { status: 503 })) : new Response(null, { status: 200 })) });
    const r = await sendFiles([pf('bad.pdf', 1), pf('ok.pdf', 1)], { fetch: s.fetch, ticket: async () => ({ kind: 'ok', url: TICKET }) });
    expect(n).toBe(2);
    expect(r.sent).toEqual(['ok.pdf']);
    expect(r.failed).toEqual([{ path: 'bad.pdf', reason: 'Frontier answered HTTP 503' }]);
  });

  it('aborts a multipart file whose part failed', async () => {
    const s = server({ put: (u) => new Response(null, { status: u.includes('p2') ? 403 : 200 }) });
    const r = await sendFiles([pf('big.pdf', 25)], { fetch: s.fetch, ticket: async () => ({ kind: 'ok', url: TICKET }) });
    expect(r.failed).toEqual([{ path: 'big.pdf', reason: 'the upload link expired; try again' }]);
    const done = s.calls.find((c) => c.url.endsWith('/complete'))!;
    expect(JSON.parse(String(done.init.body))).toEqual({ complete: [], abort: ['big.pdf'] });
  });

  it('asks for a new ticket once when the door says it expired', async () => {
    let first = true;
    const s = server({ manifest: (b) => (first ? ((first = false), new Response('not found', { status: 404 }))
      : json({ uploads: b.files.map((f: any) => ({ path: f.path, headers: {}, put_url: `${ORIGIN}/v1/files/b/k/x?X-Amz-Signature=s` })), skipped: [] })) });
    const ticket = vi.fn(async () => ({ kind: 'ok' as const, url: TICKET }));
    const r = await sendFiles([pf('a.pdf', 1)], { fetch: s.fetch, ticket });
    expect(ticket).toHaveBeenCalledTimes(2);
    expect(r.sent).toEqual(['a.pdf']);
  });

  it('never sends bytes to another origin', async () => {
    const s = server({ manifest: (b) => json({ uploads: b.files.map((f: any) => ({ path: f.path, headers: {}, put_url: 'https://elsewhere.example/x' })), skipped: [] }) });
    const r = await sendFiles([pf('a.pdf', 1)], { fetch: s.fetch, ticket: async () => ({ kind: 'ok', url: TICKET }) });
    expect(r.failed).toEqual([{ path: 'a.pdf', reason: 'Frontier sent an upload link the card cannot use; open the task in Frontier' }]);
    expect(s.calls.some((c) => c.init.method === 'PUT')).toBe(false);
  });

  it('reports a ticket the host refused, and a network failure on the manifest', async () => {
    const r1 = await sendFiles([pf('a.pdf', 1)], { fetch: server().fetch, ticket: async () => ({ kind: 'failed', message: 'Upload limit reached.' }) });
    expect(r1).toEqual({ sent: [], failed: [], skipped: [], error: 'Upload limit reached.' });
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const r2 = await sendFiles([pf('a.pdf', 1)], { fetch: down, ticket: async () => ({ kind: 'ok', url: TICKET }) });
    expect(r2.error).toBe("Couldn't reach Frontier. Check the connection and try again.");
  });

  it('reports progress per file', async () => {
    const seen: number[] = [];
    await sendFiles([pf('a.pdf', 1), pf('b.pdf', 1)], { fetch: server().fetch, ticket: async () => ({ kind: 'ok', url: TICKET }) }, (p) => seen.push(p.done));
    expect(seen.at(-1)).toBe(2);
  });

  it('keeps progress right when /complete reports a file failed', async () => {
    const s = server();
    const base = s.fetch;
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
      if (String(u).endsWith('/complete')) return json({ completed: [], failed: [{ path: 'big.pdf', reason: 'nope' }] });
      return base(u, init);
    }) as unknown as typeof fetch;
    const seen: { done: number; total: number; failed: number }[] = [];
    const r = await sendFiles([pf('big.pdf', 25), pf('a.pdf', 1)], { fetch: fetchImpl, ticket: async () => ({ kind: 'ok', url: TICKET }) }, (p) => seen.push({ ...p }));
    expect(r.sent).toEqual(['a.pdf']);
    expect(r.failed).toEqual([{ path: 'big.pdf', reason: 'nope' }]);
    expect(seen.every((p) => p.done >= 0 && p.done + p.failed <= p.total)).toBe(true);
    expect(seen.at(-1)).toEqual({ done: 1, total: 2, failed: 1 });
  });

  it('keeps progress right when /complete itself fails', async () => {
    const s = server();
    const base = s.fetch;
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
      if (String(u).endsWith('/complete')) throw new TypeError('Failed to fetch');
      return base(u, init);
    }) as unknown as typeof fetch;
    const seen: { done: number; total: number; failed: number }[] = [];
    const r = await sendFiles([pf('big.pdf', 25), pf('a.pdf', 1)], { fetch: fetchImpl, ticket: async () => ({ kind: 'ok', url: TICKET }) }, (p) => seen.push({ ...p }));
    expect(r.failed.map((f) => f.path)).toEqual(['big.pdf']);
    expect(seen.every((p) => p.done >= 0 && p.done + p.failed <= p.total)).toBe(true);
    expect(seen.at(-1)).toEqual({ done: 1, total: 2, failed: 1 });
  });

  it('refuses a part plan that is not numbered 1..N, and aborts it', async () => {
    const s = server({ manifest: (b) => json({ uploads: b.files.map((f: any) => ({ path: f.path, headers: {}, parts: [{ n: 2, size: f.size, put_url: `${ORIGIN}/v1/files/b/x?X-Amz-Signature=s` }] })), skipped: [] }) });
    const r = await sendFiles([pf('big.pdf', 25)], { fetch: s.fetch, ticket: async () => ({ kind: 'ok', url: TICKET }) });
    expect(r.failed).toEqual([{ path: 'big.pdf', reason: BAD_PLAN }]);
    expect(s.calls.some((c) => c.init.method === 'PUT')).toBe(false);
    const done = s.calls.find((c) => c.url.endsWith('/complete'))!;
    expect(JSON.parse(String(done.init.body))).toEqual({ complete: [], abort: ['big.pdf'] });
  });

  it('gives a part plan whose sizes do not add up to the file its own message', async () => {
    const s = server({ manifest: (b) => json({ uploads: b.files.map((f: any) => ({ path: f.path, headers: {}, parts: [
      { n: 1, size: 10, put_url: `${ORIGIN}/v1/files/b/k/p1?X-Amz-Signature=s` },
      { n: 2, size: 5, put_url: `${ORIGIN}/v1/files/b/k/p2?X-Amz-Signature=s` }] })), skipped: [] }) });
    const r = await sendFiles([pf('big.pdf', 25)], { fetch: s.fetch, ticket: async () => ({ kind: 'ok', url: TICKET }) });
    expect(r.failed).toEqual([{ path: 'big.pdf', reason: BAD_PLAN }]);
    expect(s.calls.some((c) => c.init.method === 'PUT')).toBe(false);
  });

  it('keeps the off-origin message for a part whose link is on another origin', async () => {
    const s = server({ manifest: (b) => json({ uploads: b.files.map((f: any) => ({ path: f.path, headers: {}, parts: [
      { n: 1, size: 25, put_url: 'https://elsewhere.example/x' }] })), skipped: [] }) });
    const r = await sendFiles([pf('big.pdf', 25)], { fetch: s.fetch, ticket: async () => ({ kind: 'ok', url: TICKET }) });
    expect(r.failed).toEqual([{ path: 'big.pdf', reason: OFF_ORIGIN }]);
    expect(s.calls.some((c) => c.init.method === 'PUT')).toBe(false);
  });

  it('never follows a redirect: the manifest, the PUTs and complete all refuse it', async () => {
    const s = server();
    await sendFiles([pf('a.pdf', 3), pf('big.pdf', 25)], { fetch: s.fetch, ticket: async () => ({ kind: 'ok', url: TICKET }) });
    const posts = s.calls.filter((c) => c.init.method === 'POST');
    const puts = s.calls.filter((c) => c.init.method === 'PUT');
    expect(posts.map((c) => c.url.split('/').pop())).toEqual(['manifest', 'complete']);
    expect(puts.length).toBe(3);
    for (const c of [...posts, ...puts]) expect(c.init.redirect, c.url).toBe('error');
  });

  it('forwards only Content-Type and Content-MD5 from the server headers, whatever their case', async () => {
    const s = server({ manifest: (b) => json({ uploads: b.files.map((f: any) => ({ path: f.path, headers: {
      'content-md5': 'abc==', 'X-Extra': 'nope', 'content-type': 'application/x-custom', Host: 'evil.example' },
      put_url: `${ORIGIN}/v1/files/b/k/x?X-Amz-Signature=s` })), skipped: [] }) });
    await sendFiles([pf('a.pdf', 1)], { fetch: s.fetch, ticket: async () => ({ kind: 'ok', url: TICKET }) });
    const put = s.calls.find((c) => c.init.method === 'PUT')!;
    expect(put.init.headers).toEqual({ 'Content-Type': 'application/x-custom', 'Content-MD5': 'abc==' });
  });

  it('defaults Content-Type to the file mime when the server sends none', async () => {
    const s = server({ manifest: (b) => json({ uploads: b.files.map((f: any) => ({ path: f.path, headers: { 'X-Extra': 'nope' },
      put_url: `${ORIGIN}/v1/files/b/k/x?X-Amz-Signature=s` })), skipped: [] }) });
    await sendFiles([pf('a.pdf', 1)], { fetch: s.fetch, ticket: async () => ({ kind: 'ok', url: TICKET }) });
    const put = s.calls.find((c) => c.init.method === 'PUT')!;
    expect(put.init.headers).toEqual({ 'Content-Type': 'application/pdf' });
  });

  it('returns at once for no files, without a ticket or a request', async () => {
    const ticket = vi.fn(async () => ({ kind: 'ok' as const, url: TICKET }));
    const fetchImpl = vi.fn();
    const r = await sendFiles([], { fetch: fetchImpl as unknown as typeof fetch, ticket });
    expect(r).toEqual({ sent: [], failed: [], skipped: [], error: null });
    expect(ticket).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function listingServer(opts: { keep?: (f: any) => boolean; missing?: boolean; multipart?: boolean; offOrigin?: boolean;
  task?: any[]; stored?: Record<string, string>; drop?: string[]; apart?: string[] } = {}) {
  const listed: any[] = [];
  const gets: string[] = [];
  const base = server();
  const stored = (p: string) => opts.stored?.[p] ?? p;
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const u = String(url);
    if (u.endsWith('/v1/connect/t/files')) { gets.push(u); return json({ task_id: 't1', files: opts.task ?? [] }); }
    if (u.endsWith('/v1/connect/t/complete')) {
      const body = JSON.parse(String(init.body));
      base.calls.push({ url: u, init });
      return json({ completed: body.complete.map(stored), failed: [] });
    }
    if (u.endsWith('/v1/connect/t/list')) {
      if (opts.missing) return json({ detail: 'Not Found' }, 404);
      const page = JSON.parse(String(init.body)).files;
      const out = page.filter((f: any) => (opts.apart ?? []).includes(f.path));
      listed.push(...page.filter((f: any) => !out.includes(f)));
      return json({ task_id: 't1', listed: listed.length, expires_in_s: 600,
        ...(out.length ? { not_sent: out.map((f: any) => ({ path: f.path, reason: 'already in this task as a file uploaded separately' })) } : {}) });
    }
    if (u.endsWith('/v1/connect/t/list/done')) {
      const kept = listed.filter((f) => !(opts.drop ?? []).includes(f.path) && (f.explicit || (opts.keep ?? (() => true))(f)));
      return json({ task_id: 't1', skipped: listed.length - kept.length, listed: listed.length,
        uploads: kept.map((f) => (opts.multipart && f.size > 10
          ? { path: stored(f.path), headers: { 'Content-Type': f.mime }, parts: [{ n: 1, size: 10, put_url: `${ORIGIN}/v1/files/b/k/p1?X-Amz-Signature=s` }, { n: 2, size: f.size - 10, put_url: `${ORIGIN}/v1/files/b/k/p2?X-Amz-Signature=s` }] }
          : { path: stored(f.path), headers: { 'Content-Type': f.mime }, put_url: `${opts.offOrigin ? 'https://evil.example' : ORIGIN}/v1/files/b/k/${encodeURIComponent(f.path)}?X-Amz-Signature=s` })) });
    }
    return (base.fetch as any)(url, init);
  });
  return { listed, gets, calls: base.calls, fetch: fetchImpl as unknown as typeof fetch };
}

describe('sendFiles with the paged listing', () => {
  const deps = (f: typeof fetch) => ({ fetch: f, ticket: async () => ({ kind: 'ok' as const, url: TICKET }) });

  it('lists in pages of 5000, then uploads what /list/done kept; the rest are listed, not failed', async () => {
    const files = Array.from({ length: 6000 }, (_, i) => ({ ...pf(`dir/f${i}.pdf`, 1), explicit: false }));
    const s = listingServer({ keep: (f) => f.path.endsWith('0.pdf') });
    const r = await sendFiles(files, deps(s.fetch));
    expect(s.listed.length).toBe(6000);
    const pages = s.calls.length; // only PUTs reach the base server
    expect(pages).toBe(600);
    expect(r.sent.length).toBe(600);
    expect(r.skipped.length).toBe(5400);
    expect(r.failed).toEqual([]);
    expect(s.listed.some((f) => 'explicit' in f)).toBe(false);
  });

  it('posts pages with their numbers and then /list/done with multipart', async () => {
    const bodies: any[] = [];
    const s = listingServer();
    const wrapped = vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => {
      if (String(u).includes('/v1/connect/t/list')) bodies.push([String(u).split('/t/')[1], JSON.parse(String(i!.body))]);
      return (s.fetch as any)(u, i);
    }) as unknown as typeof fetch;
    await sendFiles(Array.from({ length: 5001 }, (_, i) => ({ ...pf(`d/f${i}.pdf`, 1), explicit: false })), deps(wrapped));
    expect(bodies.map(([u, b]) => [u, b.page ?? b.multipart, b.files?.length])).toEqual([['list', 1, 5000], ['list', 2, 1], ['list/done', true, undefined]]);
  });

  it('files picked one by one go as explicit', async () => {
    const s = listingServer({ keep: () => false });
    const r = await sendFiles([{ ...pf('a.pdf', 1), explicit: true }], deps(s.fetch));
    expect(s.listed[0].explicit).toBe(true);
    expect(r.sent).toEqual(['a.pdf']);
    expect(r.skipped).toEqual([]);
  });

  it('never PUTs to a link off the ticket origin from /list/done', async () => {
    const s = listingServer({ offOrigin: true });
    const r = await sendFiles([{ ...pf('a.pdf', 1), explicit: true }], deps(s.fetch));
    expect(r.sent).toEqual([]);
    expect(r.failed).toEqual([{ path: 'a.pdf', reason: OFF_ORIGIN }]);
    expect(s.calls.some((c) => c.init.method === 'PUT')).toBe(false);
  });

  it('an older backend falls back to /manifest within its caps', async () => {
    const s = listingServer({ missing: true });
    const r = await sendFiles([{ ...pf('a.pdf', 1), explicit: true }], deps(s.fetch));
    expect(r.sent).toEqual(['a.pdf']);
    expect(s.calls.some((c) => c.url.endsWith('/manifest'))).toBe(true);
  });

  it('an older backend refuses a folder past its caps without sending anything', async () => {
    const s = listingServer({ missing: true });
    const files = Array.from({ length: 1001 }, (_, i) => ({ ...pf(`d/f${i}.pdf`, 1), explicit: false }));
    const r = await sendFiles(files, deps(s.fetch));
    expect(r.error).toMatch(/needs an update/);
    expect(s.calls).toEqual([]);
  });

  it('an expired ticket on /list/done gets a fresh ticket and a second full pass', async () => {
    const seen: string[] = [];
    let doneCalls = 0;
    const pages: number[] = [];
    const f = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
      const u = String(url).split('/t')[1];
      seen.push(u);
      if (u === '/list') { pages.push(JSON.parse(String(init.body)).files.length); return json({ task_id: 't1', listed: 1, expires_in_s: 600 }); }
      if (u === '/list/done') {
        if (++doneCalls === 1) return json({ detail: 'not found' }, 404);
        return json({ task_id: 't1', skipped: 0, listed: 5001, uploads: [{ path: 'd/f0.pdf', headers: {}, put_url: `${ORIGIN}/v1/files/b/k/x?X-Amz-Signature=s` }] });
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const ticket = vi.fn(async () => ({ kind: 'ok' as const, url: TICKET }));
    const files = Array.from({ length: 5001 }, (_, i) => ({ ...pf(`d/f${i}.pdf`, 1), explicit: false }));
    const r = await sendFiles(files, { fetch: f, ticket });
    expect(ticket).toHaveBeenCalledTimes(2);
    expect(pages).toEqual([5000, 1, 5000, 1]);
    expect(seen.filter((x) => x === '/list/done')).toHaveLength(2);
    expect(r.error).toBeNull();
    expect(r.sent).toEqual(['d/f0.pdf']);
    expect(r.skipped).toHaveLength(5000);
  });

  it('closes a page at about 3 MiB of encoded JSON with long non-ASCII paths', () => {
    const name = '\u00e9t\u00e9-\u5e74\u5ea6-'.repeat(20);
    const entries = Array.from({ length: 6000 }, (_, i) => ({ path: `${name}/${name}${i}.pdf`, size: 1, mime: 'application/pdf' }));
    const pages = listPages(entries);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toEqual(entries);
    const enc = new TextEncoder();
    pages.forEach((pg, i) => expect(enc.encode(JSON.stringify({ page: i + 1, files: pg })).length).toBeLessThanOrEqual(LIST_PAGE_BYTES));
    const short = Array.from({ length: 12000 }, (_, i) => ({ path: `f${i}.txt`, size: 0, mime: 'text/plain' }));
    expect(listPages(short).map((pg) => pg.length)).toEqual([5000, 5000, 2000]);
  });

  it('posts byte-bounded pages', async () => {
    const bodies: string[] = [];
    const s = listingServer();
    const wrapped = vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => {
      if (String(u).endsWith('/v1/connect/t/list')) bodies.push(String(i!.body));
      return (s.fetch as any)(u, i);
    }) as unknown as typeof fetch;
    const long = '\u5e74'.repeat(150);
    await sendFiles(Array.from({ length: 4000 }, (_, i) => ({ ...pf(`${long}/${long}${i}.pdf`, 1), explicit: false })), deps(wrapped));
    expect(bodies.length).toBeGreaterThan(1);
    const enc = new TextEncoder();
    for (const b of bodies) expect(enc.encode(b).length).toBeLessThanOrEqual(LIST_PAGE_BYTES);
    expect(s.listed.length).toBe(4000);
  });

  it('a 400 from /list/done shows the server detail that names the files', async () => {
    const f = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/list')) return json({ task_id: 't1', listed: 1, expires_in_s: 600 });
      return json({ detail: 'the files you named or attached do not fit in 1000 files and 2 GiB per task: a.pdf' }, 400);
    }) as unknown as typeof fetch;
    const r = await sendFiles([pf('a.pdf', 1)], deps(f));
    expect(r.error).toBe('Frontier refused the upload: the files you named or attached do not fit in 1000 files and 2 GiB per task: a.pdf');
  });

  it('a dead ticket (lower-case "not found") is an expired link, not a missing route', async () => {
    let n = 0;
    const f = vi.fn(async (url: RequestInfo | URL) => { if (String(url).endsWith('/list')) n++; return json({ detail: 'not found' }, 404); }) as unknown as typeof fetch;
    const r = await sendFiles([pf('a.pdf', 1)], { fetch: f, ticket: async () => ({ kind: 'ok', url: TICKET }) });
    expect(r.error).toMatch(/expired/);
    expect(n).toBe(2); // one fresh-ticket retry, no /manifest fallback
  });

  it('a link for a row stored in another case still sends the picked file (and completes it)', async () => {
    const s = listingServer({ stored: { 'docs/plan.PDF': 'Docs/Plan.pdf', 'big.bin': 'BIG.bin' }, multipart: true });
    const r = await sendFiles([{ ...pf('docs/plan.PDF', 3), explicit: false }, { ...pf('big.bin', 25), explicit: false }], deps(s.fetch));
    expect(r).toEqual({ sent: ['docs/plan.PDF', 'big.bin'], failed: [], skipped: [], error: null });
    expect(s.calls.filter((c) => c.init.method === 'PUT')).toHaveLength(3);
  });

  it('a picked file of another size than the one the task holds by that name goes up alongside', async () => {
    const s = listingServer({ task: [{ path: 'Report.pdf', size: 5, status: 'issued' }, { path: 'report (2).pdf', size: 7, status: 'issued' }] });
    const r = await sendFiles([pf('report.pdf', 9)], deps(s.fetch));
    expect(s.listed.map((f) => f.path)).toEqual(['report (3).pdf']);
    expect(r.sent).toEqual(['report.pdf']);
    expect(r.renamed).toEqual([{ from: 'report.pdf', to: 'report (3).pdf' }]);
  });

  it('the same picked file again (same name and size) is sent in place', async () => {
    const s = listingServer({ task: [{ path: 'report.pdf', size: 5, status: 'issued' }] });
    const r = await sendFiles([pf('report.pdf', 5)], deps(s.fetch));
    expect(s.listed.map((f) => f.path)).toEqual(['report.pdf']);
    expect(r).toEqual({ sent: ['report.pdf'], failed: [], skipped: [], error: null });
  });

  it('a folder alone never reads the task state', async () => {
    const s = listingServer();
    await sendFiles([{ ...pf('d/a.pdf', 1), explicit: false }], deps(s.fetch));
    expect(s.gets).toEqual([]);
  });

  it('a file picked one by one that gets no link is a failure, never "listed"', async () => {
    const s = listingServer({ drop: ['a.pdf'] });
    const r = await sendFiles([pf('a.pdf', 1), { ...pf('d/b.pdf', 1), explicit: false }], deps(s.fetch));
    expect(r.failed).toEqual([{ path: 'a.pdf', reason: 'Frontier sent no upload link for it' }]);
    expect(r.skipped).toEqual([]);
    expect(r.sent).toEqual(['d/b.pdf']);
  });

  it('a direct upload of that name counts as a file the task holds', async () => {
    const s = listingServer({ task: [{ path: 'report.pdf', size: 5, status: 'uploaded' }, { path: 'x.pdf', size: 1, status: 'expired' }] });
    await sendFiles([pf('report.pdf', 9), pf('x.pdf', 7)], deps(s.fetch));
    expect(s.listed.map((f) => f.path)).toEqual(['report (2).pdf', 'x.pdf']);
  });

  it('the alias for a folder named attached skips the top folders the task already holds', async () => {
    const s = listingServer({ task: [{ path: 'attached (2)/old.pdf', size: 1, status: 'issued' }] });
    const f = { ...pf('attached (2)/y.pdf', 1), explicit: false, aliasOf: 'attached' };
    const r = await sendFiles([f, { ...pf('d/z.pdf', 1), explicit: false }], deps(s.fetch));
    expect(s.listed.map((x) => x.path)).toEqual(['attached (3)/y.pdf', 'd/z.pdf']);
    expect(r.sent).toEqual(['attached (2)/y.pdf', 'd/z.pdf']);  // the picked paths, as always
    expect(r.renamed).toEqual([{ from: 'attached (2)/y.pdf', to: 'attached (3)/y.pdf' }]);
  });

  it('reports the alias it used even when the aliased file fails (review 5 R5-6)', async () => {
    const s = listingServer({ task: [{ path: 'attached (2)/old.pdf', size: 1, status: 'issued' }] });
    const failing = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === 'PUT') throw new TypeError('network down');
      return (s.fetch as any)(url, init);
    }) as unknown as typeof fetch;
    const r = await sendFiles([{ ...pf('attached (2)/y.pdf', 1), explicit: false, aliasOf: 'attached' }], deps(failing));
    expect(r.failed.map((x) => x.path)).toEqual(['attached (2)/y.pdf']);
    expect(r.renamed).toBeUndefined();
    expect(r.alias).toBe('attached (3)');
  });

  it('a folder file Frontier leaves out of the listing is reported not sent, never "listed"', async () => {
    const s = listingServer({ apart: ['d/notes.md'] });
    const r = await sendFiles([{ ...pf('d/notes.md', 9), explicit: false }, { ...pf('d/a.pdf', 1), explicit: false }], deps(s.fetch));
    expect(r.sent).toEqual(['d/a.pdf']);
    expect(r.skipped).toEqual([]);
    expect(r.notSent).toEqual([{ path: 'd/notes.md', reason: 'already in this task as a file uploaded separately' }]);
  });
});
