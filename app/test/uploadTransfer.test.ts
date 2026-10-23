import { describe, expect, it, vi } from 'vitest';
import type { PickedFile } from '../src/upload/manifest';
import { parseTicketUrl, sendFiles } from '../src/upload/transfer';

const ORIGIN = 'https://api.example.com';
const TICKET = `${ORIGIN}/v1/connect/t#${'A'.repeat(43)}`;
const pf = (path: string, size: number): PickedFile => ({ path, size, mime: 'application/pdf', blob: new Blob([new Uint8Array(size)]) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const OFF_ORIGIN = 'Frontier sent an upload link the card cannot use; open the task in Frontier';
const BAD_PLAN = 'Frontier sent an unusable upload plan; try again';

function server(opts: { manifest?: (b: any) => Response; put?: (url: string, init: RequestInit) => Response } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const u = String(url);
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
    expect(r).toEqual({ sent: ['a.pdf', 'b/c.pdf'], failed: [], error: null });
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
    expect(r1).toEqual({ sent: [], failed: [], error: 'Upload limit reached.' });
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
    expect(r).toEqual({ sent: [], failed: [], error: null });
    expect(ticket).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
