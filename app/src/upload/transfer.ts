import type { PickedFile } from './manifest';

/** The plugin helper's ticket protocol, from the card (spec 2026-10-22-card-files §4.2):
 * manifest → PUTs (single, or parts) → complete. Bytes go only to links on the ticket's origin. */
export type TicketResult = { kind: 'ok'; url: string } | { kind: 'failed'; message: string };
export interface TransferDeps { fetch: typeof fetch; ticket: () => Promise<TicketResult> }
export interface Progress { done: number; total: number; failed: number }
export interface SendResult { sent: string[]; failed: { path: string; reason: string }[]; error: string | null }

export const WORKERS = 4;
const TICKET_PATH = '/v1/connect/t';
const RAW = /^[A-Za-z0-9_-]{16,256}$/;
const NET = "Couldn't reach Frontier. Check the connection and try again.";
const EXPIRED = 'the upload link expired; try again';
const OFF_ORIGIN = 'Frontier sent an upload link the card cannot use; open the task in Frontier';
const BAD_PLAN = 'Frontier sent an unusable upload plan; try again';

export function parseTicketUrl(url: string): { origin: string; raw: string } | null {
  try {
    const u = new URL(url);
    const raw = u.hash.slice(1);
    if (u.protocol !== 'https:' || u.pathname !== TICKET_PATH || u.search || u.username || !RAW.test(raw)) return null;
    return { origin: u.origin, raw };
  } catch {
    return null;
  }
}

class DoorError extends Error {
  constructor(public status: number | null, message: string) { super(message); }
}

async function door(deps: TransferDeps, t: { origin: string; raw: string }, sub: string, body: unknown): Promise<any> {
  let r: Response;
  try {
    r = await deps.fetch(`${t.origin}${TICKET_PATH}${sub}`, {
      method: 'POST',
      headers: { Authorization: `Ticket ${t.raw}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
    });
  } catch {
    throw new DoorError(null, NET);
  }
  if (r.status === 404) throw new DoorError(404, 'This upload link expired. Try again.');
  if (r.status === 429) throw new DoorError(429, 'Frontier is rate limiting uploads. Wait a minute, then try again.');
  if (r.status === 402) throw new DoorError(402, 'Your Frontier plan is inactive, so Frontier cannot take files right now.');
  if (!r.ok) throw new DoorError(r.status, `Frontier refused the upload (HTTP ${r.status}).`);
  return r.json();
}

/** A fresh ticket, or the reason there is none. */
async function freshTicket(deps: TransferDeps): Promise<{ origin: string; raw: string } | string> {
  const t = await deps.ticket();
  if (t.kind === 'failed') return t.message;
  return parseTicketUrl(t.url) ?? "Frontier's upload link was not usable. Try again.";
}

async function put(deps: TransferDeps, url: string, headers: Record<string, string>, body: Blob): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let r: Response;
    try {
      // redirect: 'error' keeps the bytes on the ticket's origin. A refused redirect is a TypeError,
      // indistinguishable from a network failure, so it takes the one retry; the retry targets the same URL.
      r = await deps.fetch(url, { method: 'PUT', headers, body, redirect: 'error' });
    } catch {
      if (attempt === 1) return 'network error';
      continue;
    }
    if (r.ok) return null;
    if (r.status === 403) return EXPIRED;
    if (r.status < 500 || attempt === 1) return `Frontier answered HTTP ${r.status}`;
  }
  return 'network error';
}

export async function sendFiles(files: PickedFile[], deps: TransferDeps, onProgress?: (p: Progress) => void): Promise<SendResult> {
  if (files.length === 0) return { sent: [], failed: [], error: null };
  let t = await freshTicket(deps);
  if (typeof t === 'string') return { sent: [], failed: [], error: t };
  const manifest = { files: files.map((f) => ({ path: f.path, size: f.size, mime: f.mime, explicit: true })), multipart: true };
  let resp: any;
  try {
    try {
      resp = await door(deps, t, '/manifest', manifest);
    } catch (e) {
      if (!(e instanceof DoorError) || e.status !== 404) throw e;
      t = await freshTicket(deps);
      if (typeof t === 'string') return { sent: [], failed: [], error: t };
      resp = await door(deps, t, '/manifest', manifest);
    }
  } catch (e) {
    return { sent: [], failed: [], error: e instanceof Error ? e.message : NET };
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const failed = new Map<string, string>();
  type Job = { path: string; url: string; headers: Record<string, string>; blob: Blob };
  const jobs: Job[] = [];
  const multi = new Set<string>();
  const sameOrigin = (u: unknown) => { try { return typeof u === 'string' && new URL(u).origin === (t as { origin: string }).origin; } catch { return false; } };
  for (const up of Array.isArray(resp?.uploads) ? resp.uploads : []) {
    const f = typeof up?.path === 'string' ? byPath.get(up.path) : undefined;
    if (!f) continue;
    // Allowlist: only these two server headers are forwarded; everything else is dropped.
    const headers: Record<string, string> = { 'Content-Type': f.mime };
    for (const [k, v] of Object.entries(up.headers && typeof up.headers === 'object' ? up.headers : {})) {
      if (typeof v !== 'string' || /[\r\n]/.test(v)) continue;
      const name = k.toLowerCase();
      if (name === 'content-type') headers['Content-Type'] = v;
      else if (name === 'content-md5') headers['Content-MD5'] = v;
    }
    if (Array.isArray(up.parts)) {
      multi.add(f.path);
      let off = 0;
      const parts: Job[] = [];
      let plan: string | null = null;
      for (const [i, p] of up.parts.entries()) {
        if (p?.n !== i + 1 || !Number.isInteger(p.size) || p.size <= 0) { plan = BAD_PLAN; break; }
        if (!sameOrigin(p.put_url)) { plan = OFF_ORIGIN; break; }
        parts.push({ path: f.path, url: p.put_url, headers, blob: f.blob.slice(off, off + p.size) });
        off += p.size;
      }
      if (!plan && (!parts.length || off !== f.size)) plan = BAD_PLAN;
      if (plan) failed.set(f.path, plan);
      else jobs.push(...parts);
    } else if (sameOrigin(up.put_url)) {
      jobs.push({ path: f.path, url: up.put_url, headers, blob: f.blob });
    } else {
      failed.set(f.path, OFF_ORIGIN);
    }
  }
  for (const f of files) if (!jobs.some((j) => j.path === f.path) && !failed.has(f.path)) failed.set(f.path, 'Frontier did not take this file');
  const remaining = new Map<string, number>();
  for (const j of jobs) remaining.set(j.path, (remaining.get(j.path) ?? 0) + 1);
  // done is derived from state, never counted up and down: a file counts once it is fully sent
  // and stops counting the moment anything (a later part, /complete) fails it.
  const finished = new Set<string>();
  const report = () => onProgress?.({ done: [...finished].filter((p) => !failed.has(p)).length, total: files.length, failed: failed.size });
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      if (failed.has(j.path)) continue;
      const why = await put(deps, j.url, j.headers, j.blob);
      if (why) failed.set(j.path, why);
      const left = (remaining.get(j.path) ?? 1) - 1;
      remaining.set(j.path, left);
      if (left === 0) finished.add(j.path);
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, jobs.length) }, worker));
  if (multi.size) {
    const complete = [...multi].filter((p) => !failed.has(p));
    const abort = [...multi].filter((p) => failed.has(p));
    try {
      let fin: any;
      try {
        fin = await door(deps, t, '/complete', { complete, abort });
      } catch (e) {
        if (!(e instanceof DoorError) || e.status !== 404) throw e;
        const t2 = await freshTicket(deps);
        if (typeof t2 === 'string') throw new DoorError(null, t2);
        fin = await door(deps, t2, '/complete', { complete, abort });
      }
      const completed = new Set<string>(Array.isArray(fin?.completed) ? fin.completed.filter((x: unknown) => typeof x === 'string') : []);
      const told = new Map<string, string>();
      for (const x of Array.isArray(fin?.failed) ? fin.failed : []) {
        if (typeof x?.path === 'string' && typeof x.reason === 'string') told.set(x.path, x.reason);
      }
      for (const p of complete) {
        if (!completed.has(p)) failed.set(p, told.get(p) || 'Frontier could not finish the upload');
      }
    } catch (e) {
      for (const p of complete) failed.set(p, e instanceof Error ? e.message : NET);
    }
  }
  report();
  return {
    sent: files.map((f) => f.path).filter((p) => !failed.has(p)),
    failed: files.filter((f) => failed.has(f.path)).map((f) => ({ path: f.path, reason: failed.get(f.path)! })),
    error: null,
  };
}
