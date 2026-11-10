import { attachedAlias, LIST_PAGE, LIST_PAGE_BYTES, MAX_FILES, MAX_TOTAL_BYTES, relpathKey, type PickedFile } from './manifest';

/** The plugin helper's ticket protocol, from the card (spec 2026-10-22-card-files §4.2):
 * list (pages) → list/done → PUTs (an older backend: manifest → PUTs (single, or parts) → complete). Bytes go only to links on the ticket's origin. */
export type TicketResult = { kind: 'ok'; url: string } | { kind: 'failed'; message: string };
export interface TransferDeps { fetch: typeof fetch; ticket: () => Promise<TicketResult> }
export interface Progress { done: number; total: number; failed: number }
/** Paths are the picked ones. `renamed` (only when not empty): picked files that went up under
 * another name because the task holds another file of that name (see `apartFromTask`). `alias`
 * (only when the pick had aliased files): the top folder they were sent under, failed or not. */
export interface SendResult { sent: string[]; failed: { path: string; reason: string }[]; skipped: string[]; error: string | null; renamed?: { from: string; to: string }[]; notSent?: { path: string; reason: string }[]; alias?: string }

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

/** The /list pages: each closes at LIST_PAGE entries or LIST_PAGE_BYTES of the UTF-8 JSON body,
 * whichever comes first (long non-ASCII paths would otherwise pass the server's 4 MiB). */
export function listPages<T>(entries: T[]): T[][] {
  const enc = new TextEncoder();
  const room = LIST_PAGE_BYTES - enc.encode(JSON.stringify({ page: 1000, files: [] })).length;
  const pages: T[][] = [];
  let page: T[] = [];
  let used = 0;
  for (const e of entries) {
    const n = enc.encode(JSON.stringify(e)).length + 1; // the comma between entries
    if (page.length && (page.length >= LIST_PAGE || used + n > room)) { pages.push(page); page = []; used = 0; }
    page.push(e);
    used += n;
  }
  if (page.length) pages.push(page);
  return pages;
}

class DoorError extends Error {
  constructor(public status: number | null, message: string, public missing = false) { super(message); }
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
  if (r.status === 404) {
    // The server framework's own 404 ("Not Found") means this backend has no such route; the ticket door's own says "not found".
    const detail = await r.json().then((b) => (b && typeof b.detail === 'string' ? b.detail : ''), () => '');
    if (detail === 'Not Found') throw new DoorError(404, 'Frontier needs an update to take these files.', true);
    throw new DoorError(404, 'This upload link expired. Try again.');
  }
  if (r.status === 429) throw new DoorError(429, 'Frontier is rate limiting uploads. Wait a minute, then try again.');
  if (r.status === 402) throw new DoorError(402, 'Your Frontier plan is inactive, so Frontier cannot take files right now.');
  if (r.status === 400) {
    // The server's own words name what does not fit (e.g. the files the user named): show them.
    const detail = await r.json().then((b) => (b && typeof b.detail === 'string' ? b.detail : ''), () => '');
    const clean = detail.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 600);
    throw new DoorError(400, clean ? `Frontier refused the upload: ${clean}` : 'Frontier refused the upload (HTTP 400).');
  }
  if (!r.ok) throw new DoorError(r.status, `Frontier refused the upload (HTTP ${r.status}).`);
  return r.json();
}

/** A fresh ticket, or the reason there is none. */
async function freshTicket(deps: TransferDeps): Promise<{ origin: string; raw: string } | string> {
  const t = await deps.ticket();
  if (t.kind === 'failed') return t.message;
  return parseTicketUrl(t.url) ?? "Frontier's upload link was not usable. Try again.";
}

/** The task's folder state (the upload ticket's GET /t/files), by key. Best effort: on any
 * failure it is empty, and the server still refuses to let a listing silently replace a file. */
async function taskFiles(deps: TransferDeps, t: { origin: string; raw: string }): Promise<Map<string, { size: number; status: string }>> {
  const out = new Map<string, { size: number; status: string }>();
  try {
    const r = await deps.fetch(`${t.origin}${TICKET_PATH}/files`, {
      method: 'GET', headers: { Authorization: `Ticket ${t.raw}`, Accept: 'application/json' }, redirect: 'error' });
    if (!r.ok) return out;
    const b = await r.json();
    for (const x of Array.isArray(b?.files) ? b.files : []) {
      if (typeof x?.path === 'string' && Number.isInteger(x.size) && typeof x.status === 'string') out.set(relpathKey(x.path), { size: x.size, status: x.status });
    }
  } catch {
    /* empty: see above */
  }
  return out;
}

const numbered = (name: string, n: number) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
};

/** Files picked one by one, as the helper does for --add (owner decision 2026-11-09): same name
 * and same size as a file the task holds is the same file, sent again in place; another file of
 * that name (another size) goes up as "name (2).ext", "(3)"…, skipping names this pick or the
 * task already use. A path that holds nothing (not `issued`, nor a direct upload, `uploaded`) is
 * free to take over. */
function apartFromTask(files: PickedFile[], task: Map<string, { size: number; status: string }>): PickedFile[] {
  const taken = new Set(files.map((f) => relpathKey(f.path)));
  return files.map((f) => {
    if (!f.explicit) return f;
    const own = relpathKey(f.path);
    for (let n = 1, cand = f.path; ; cand = numbered(f.path, ++n)) {
      const key = relpathKey(cand);
      const held = task.get(key);
      const holds = !!held && (held.status === 'issued' || held.status === 'uploaded'); // a direct upload too
      if ((key === own || !taken.has(key)) && (!holds || held!.size === f.size)) {
        taken.add(key);
        return cand === f.path ? f : { ...f, path: cand };
      }
    }
  });
}

/** A picked folder named `attached` goes up under an alias (plan()); when the task already
 * holds that top folder, the alias moves to the first `attached (n)` neither the task nor this
 * pick uses, so it never lands on another folder's files. */
function aliasApartFromTask(files: PickedFile[], task: Map<string, { size: number; status: string }>): PickedFile[] {
  const aliased = files.filter((f) => f.aliasOf);
  if (!aliased.length) return files;
  const top = aliased[0].path.split('/', 1)[0];
  const held = new Set([...task.keys()].filter((k) => k.includes('/')).map((k) => k.split('/', 1)[0]));
  if (!held.has(relpathKey(top))) return files;
  const picked = files.filter((f) => !f.aliasOf && f.path.includes('/')).map((f) => relpathKey(f.path.split('/', 1)[0]));
  const alias = attachedAlias(new Set([...held, ...picked]));
  return files.map((f) => (f.aliasOf ? { ...f, path: `${alias}${f.path.slice(f.path.indexOf('/'))}` } : f));
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
  if (files.length === 0) return { sent: [], failed: [], skipped: [], error: null };
  let t = await freshTicket(deps);
  if (typeof t === 'string') return { sent: [], failed: [], skipped: [], error: t };
  const picked = files;
  if (files.some((f) => f.explicit || f.aliasOf)) {
    const task = await taskFiles(deps, t);
    files = apartFromTask(files, task);
    files = aliasApartFromTask(files, task);
  }
  const pickedPath = new Map(files.map((f, i) => [f.path, picked[i].path]));
  const entries = files.map((f) => ({ path: f.path, size: f.size, mime: f.mime, ...(f.explicit ? { explicit: true } : {}) }));
  // Folder files Frontier leaves out of the listing (beside a file uploaded separately): not sent.
  const leftOut = new Map<string, string>();
  const viaListing = async (tk: { origin: string; raw: string }) => {
    leftOut.clear();
    for (const [i, page] of listPages(entries).entries()) {
      const ans = await door(deps, tk, '/list', { page: i + 1, files: page });
      for (const x of Array.isArray(ans?.not_sent) ? ans.not_sent : []) {
        if (typeof x?.path === 'string') leftOut.set(relpathKey(x.path), typeof x.reason === 'string' ? x.reason.slice(0, 200) : 'not sent');
      }
    }
    return door(deps, tk, '/list/done', { multipart: true });
  };
  let listing = true;
  let resp: any;
  try {
    try {
      resp = await viaListing(t);
    } catch (e) {
      if (!(e instanceof DoorError) || e.status !== 404 || e.missing) throw e;
      t = await freshTicket(deps);
      if (typeof t === 'string') return { sent: [], failed: [], skipped: [], error: t };
      resp = await viaListing(t);
    }
  } catch (e) {
    if (!(e instanceof DoorError) || !e.missing) {
      return { sent: [], failed: [], skipped: [], error: e instanceof Error ? e.message : NET };
    }
    if (files.length > MAX_FILES || files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) {
      return { sent: [], failed: [], skipped: [], error: `Frontier needs an update to take this many files. Pick a subfolder of at most ${MAX_FILES} files and 2 GiB.` };
    }
    listing = false;
    const manifest = { files: entries.map((x) => ({ ...x, explicit: true })), multipart: true };
    try {
      try {
        resp = await door(deps, t as { origin: string; raw: string }, '/manifest', manifest);
      } catch (e2) {
        if (!(e2 instanceof DoorError) || e2.status !== 404 || e2.missing) throw e2;
        t = await freshTicket(deps);
        if (typeof t === 'string') return { sent: [], failed: [], skipped: [], error: t };
        resp = await door(deps, t, '/manifest', manifest);
      }
    } catch (e2) {
      return { sent: [], failed: [], skipped: [], error: e2 instanceof Error ? e2.message : NET };
    }
  }
  // By key: a row the task already holds keeps its stored spelling (another case, or the one an
  // open multipart upload was made from), and its link is still this file's.
  const byPath = new Map(files.map((f) => [relpathKey(f.path), f]));
  const failed = new Map<string, string>();
  type Job = { path: string; url: string; headers: Record<string, string>; blob: Blob };
  const jobs: Job[] = [];
  const multi = new Set<string>();
  const sameOrigin = (u: unknown) => { try { return typeof u === 'string' && new URL(u).origin === (t as { origin: string }).origin; } catch { return false; } };
  for (const up of Array.isArray(resp?.uploads) ? resp.uploads : []) {
    const f = typeof up?.path === 'string' ? byPath.get(relpathKey(up.path)) : undefined;
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
  const skipped: string[] = [];
  const jobPaths = new Set(jobs.map((j) => j.path));
  for (const f of files) {
    if (jobPaths.has(f.path) || failed.has(f.path) || leftOut.has(relpathKey(f.path))) continue;
    // A folder file Frontier did not keep is listed for it to ask for, not a failure. A file
    // picked one by one is always sent: no link for it is a failure (as in the helper).
    if (listing && !f.explicit) skipped.push(f.path);
    else failed.set(f.path, listing ? 'Frontier sent no upload link for it' : 'Frontier did not take this file');
  }
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
      // Frontier answers with the spelling the task's row keeps: match by key.
      const completed = new Set<string>(Array.isArray(fin?.completed) ? fin.completed.filter((x: unknown) => typeof x === 'string').map(relpathKey) : []);
      const told = new Map<string, string>();
      for (const x of Array.isArray(fin?.failed) ? fin.failed : []) {
        if (typeof x?.path === 'string' && typeof x.reason === 'string') told.set(relpathKey(x.path), x.reason);
      }
      for (const p of complete) {
        if (!completed.has(relpathKey(p))) failed.set(p, told.get(relpathKey(p)) || 'Frontier could not finish the upload');
      }
    } catch (e) {
      for (const p of complete) failed.set(p, e instanceof Error ? e.message : NET);
    }
  }
  report();
  const skippedSet = new Set(skipped);
  const back = (p: string) => pickedPath.get(p) ?? p;
  const renamed = files.filter((f) => back(f.path) !== f.path && !failed.has(f.path)).map((f) => ({ from: back(f.path), to: f.path }));
  const notSent = files.filter((f) => leftOut.has(relpathKey(f.path))).map((f) => ({ path: back(f.path), reason: leftOut.get(relpathKey(f.path))! }));
  const out = new Set(files.filter((f) => leftOut.has(relpathKey(f.path))).map((f) => f.path));
  const alias = files.find((f) => f.aliasOf)?.path.split('/', 1)[0];
  return {
    sent: files.map((f) => f.path).filter((p) => !failed.has(p) && !skippedSet.has(p) && !out.has(p)).map(back),
    failed: files.filter((f) => failed.has(f.path)).map((f) => ({ path: back(f.path), reason: failed.get(f.path)! })),
    skipped: skipped.map(back),
    error: null,
    ...(renamed.length ? { renamed } : {}),
    ...(notSent.length ? { notSent } : {}),
    ...(alias !== undefined ? { alias } : {}),
  };
}
