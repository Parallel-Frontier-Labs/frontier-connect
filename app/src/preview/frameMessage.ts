// frontier-connect/app/src/preview/frameMessage.ts
import type { Deliverable } from '../types';

/** What the card accepts from an HTML preview frame (spec 2026-11-02 §3, §5). The frame is untrusted. */
export type FrameMessage =
  | { kind: 'download'; name: string; mime: string; base64: string }
  | { kind: 'link'; href: string }
  | { kind: 'file'; href: string };

export const FRAME_MAX_BYTES = 10 * 1024 * 1024;
const MAX_B64 = Math.ceil((FRAME_MAX_BYTES * 4) / 3) + 4;
const B64 = /^[A-Za-z0-9+/=\s]*$/;

export function readFrameMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type !== 'frontier:frame' || d.v !== 1) return null;
  if (d.kind === 'file') {
    return typeof d.href === 'string' && d.href.length > 0 && d.href.length <= 1024 ? { kind: 'file', href: d.href } : null;
  }
  if (d.kind === 'link') {
    if (typeof d.href !== 'string' || d.href.length > 2048) return null;
    let u: URL;
    try { u = new URL(d.href); } catch { return null; }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) return null;
    return { kind: 'link', href: u.href };
  }
  if (d.kind === 'download') {
    const { name, mime, base64 } = d;
    if (typeof name !== 'string' || name.length > 1024) return null;
    if (typeof mime !== 'string' || mime.length > 255) return null;
    if (typeof base64 !== 'string' || base64.length > MAX_B64 || !B64.test(base64)) return null;
    return { kind: 'download', name, mime, base64 };
  }
  return null;
}

/** A base name safe to hand a host: no directories, no control characters, <= 255 chars. */
export function safeName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return clean && clean !== '.' && clean !== '..' ? clean : 'download';
}

/** The last segment of a relative href, decoded when it can be, for messages. */
export function hrefName(href: string): string {
  const seg = (href.split(/[?#]/)[0] ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  try { return safeName(decodeURIComponent(seg)); } catch { return safeName(seg); }
}

/** A relative href from the previewed file, resolved to one of the task's deliverables: the exact
 * path, else the only deliverable with that base name. Never above the task root. */
export function resolveSibling(previewPath: string, href: string, files: readonly Deliverable[]): Deliverable | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
  let rel = href.split(/[?#]/)[0] ?? '';
  try { rel = decodeURIComponent(rel); } catch { return null; }
  rel = rel.replace(/\\/g, '/');
  if (!rel || rel.startsWith('/')) return null;
  const cut = previewPath.lastIndexOf('/');
  const out = cut > 0 ? previewPath.slice(0, cut).split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (!out.length) return null;
  const target = out.join('/');
  const exact = files.find((f) => f.path === target);
  if (exact) return exact;
  const base = out[out.length - 1];
  const same = files.filter((f) => (f.path.split('/').pop() ?? f.name) === base);
  return same.length === 1 ? same[0]! : null;
}
