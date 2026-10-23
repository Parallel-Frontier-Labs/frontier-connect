import type { LinkOutcome } from '../bridge';
import { staticBase } from '../staticBase';
import { MAX_PREVIEW_BYTES } from './kind';

export type FileBytes = { kind: 'ok'; bytes: Uint8Array } | { kind: 'too_large' } | { kind: 'failed'; message: string };
const NOT_HERE = "Couldn't open this file here.";
const FAILED = "Couldn't load this file. Try again.";

/** The bytes of one delivered file, through its presigned link, only from the card's own server. */
export async function fetchFileBytes(link: (path: string) => Promise<LinkOutcome>, path: string, fetchImpl: typeof fetch = fetch): Promise<FileBytes> {
  const l = await link(path);
  if (l.kind === 'failed') return { kind: 'failed', message: l.message };
  const base = staticBase();
  let ok = false;
  try { ok = !!base && new URL(l.url).origin === new URL(base).origin; } catch { ok = false; }
  if (!ok) return { kind: 'failed', message: NOT_HERE };
  let r: Response;
  try { r = await fetchImpl(l.url, { redirect: 'error' }); } catch { return { kind: 'failed', message: FAILED }; }
  if (!r.ok) return { kind: 'failed', message: FAILED };
  const header = r.headers.get('Content-Length');
  const declared = header === null || header.trim() === '' ? NaN : Number(header);
  if (Number.isFinite(declared)) {
    if (declared > MAX_PREVIEW_BYTES) {
      // Never read: release the connection instead of leaving the body open.
      try { void r.body?.cancel().catch(() => {}); } catch { /* a locked or odd body: nothing to release */ }
      return { kind: 'too_large' };
    }
    const bytes = new Uint8Array(await r.arrayBuffer());
    return bytes.byteLength > MAX_PREVIEW_BYTES ? { kind: 'too_large' } : { kind: 'ok', bytes };
  }
  if (!r.body) {
    const bytes = new Uint8Array(await r.arrayBuffer());
    return bytes.byteLength > MAX_PREVIEW_BYTES ? { kind: 'too_large' } : { kind: 'ok', bytes };
  }
  // No usable length: count as we read and stop once past the cap.
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PREVIEW_BYTES) {
        await reader.cancel().catch(() => {});
        return { kind: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: 'failed', message: FAILED };
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  return { kind: 'ok', bytes };
}
