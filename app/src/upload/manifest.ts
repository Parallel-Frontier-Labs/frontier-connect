/** What the card sends for the files the user picked: the plugin helper's path rules
 * (plugin/skills/frontier/scripts/frontier.py safe_relpath, relpath_key, walk), checked before
 * anything leaves the card. Every entry is explicit: the card cannot re-read the folder later. */
export interface PickedFile { path: string; size: number; mime: string; blob: Blob }
export interface NotSent { path: string; reason: string }
export interface Plan { send: PickedFile[]; notSent: NotSent[]; skipped: number; error: string | null; total: number }

export const MAX_FILES = 1000;
export const MAX_TOTAL_BYTES = 2 * 1024 ** 3;
const MAX_RELPATH = 512;
const MAX_SEGMENT_BYTES = 255;
const RESERVED_TOP = '.frontier';
const RESERVED_TOP_FILES = new Set(['folder-index.md', 'context.md']);
const DEVICES = new Set(['CON', 'PRN', 'AUX', 'NUL', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((i) => [`COM${i}`, `LPT${i}`])]);
const BAD_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CLUTTER = new Set(['thumbs.db', 'desktop.ini']);
const MIME: Record<string, string> = {
  pdf: 'application/pdf', csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', md: 'text/markdown',
  json: 'application/json', html: 'text/html', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip',
};
let enc: TextEncoder | undefined;

function segmentOk(seg: string): boolean {
  if (seg === '' || seg === '.' || seg === '..') return false;
  if (seg.endsWith('.') || seg.endsWith(' ')) return false;
  if ((enc ??= new TextEncoder()).encode(seg).length > MAX_SEGMENT_BYTES) return false;
  return !DEVICES.has(seg.split('.', 1)[0].trim().toUpperCase());
}

export function safeRelpath(raw: string): string | null {
  const p = raw.normalize('NFC');
  if (!p || [...p].length > MAX_RELPATH || BAD_CHARS.test(p) || p.includes('\\')) return null;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const segs = p.split('/');
  if (!segs.every(segmentOk)) return null;
  if (relpathKey(segs[0]) === RESERVED_TOP) return null;
  return p;
}

/** The server's duplicate key is Python unicodedata.normalize('NFC', p).casefold(). toLowerCase is
 * not casefold (and an upper/lower round trip differs both ways), so fold each code point: the
 * exceptions below were generated from Python 3.14 (Unicode 16.0), everything else lowercases
 * one code point at a time, so JS's final-sigma context rule never applies. */
const FOLD = 'b5:3bc;df:73,73;149:2bc,6e;17f:73;1f0:6a,30c;345:3b9;390:3b9,308,301;3b0:3c5,308,301;3c2:3c3;3d0:3b2;3d1:3b8;3d5:3c6;3d6:3c0;3f0:3ba;3f1:3c1;3f5:3b5;587:565,582;1c80:432;1c81:434;1c82:43e;1c83:441;1c84:442;1c85:442;1c86:44a;1c87:463;1c88:a64b;1e96:68,331;1e97:74,308;1e98:77,30a;1e99:79,30a;1e9a:61,2be;1e9b:1e61;1e9e:73,73;1f50:3c5,313;1f52:3c5,313,300;1f54:3c5,313,301;1f56:3c5,313,342;1fb2:1f70,3b9;1fb3:3b1,3b9;1fb4:3ac,3b9;1fb6:3b1,342;1fb7:3b1,342,3b9;1fbc:3b1,3b9;1fbe:3b9;1fc2:1f74,3b9;1fc3:3b7,3b9;1fc4:3ae,3b9;1fc6:3b7,342;1fc7:3b7,342,3b9;1fcc:3b7,3b9;1fd2:3b9,308,300;1fd3:3b9,308,301;1fd6:3b9,342;1fd7:3b9,308,342;1fe2:3c5,308,300;1fe3:3c5,308,301;1fe4:3c1,313;1fe6:3c5,342;1fe7:3c5,308,342;1ff2:1f7c,3b9;1ff3:3c9,3b9;1ff4:3ce,3b9;1ff6:3c9,342;1ff7:3c9,342,3b9;1ffc:3c9,3b9;fb00:66,66;fb01:66,69;fb02:66,6c;fb03:66,66,69;fb04:66,66,6c;fb05:73,74;fb06:73,74;fb13:574,576;fb14:574,565;fb15:574,56b;fb16:57e,576;fb17:574,56d';
const BASE: Record<number, number> = { 0x1f80: 0x1f00, 0x1f88: 0x1f00, 0x1f90: 0x1f20, 0x1f98: 0x1f20, 0x1fa0: 0x1f60, 0x1fa8: 0x1f60 };
let fold: Map<number, number[]> | undefined;
function foldCp(cp: number): string {
  fold ??= new Map(FOLD.split(';').map((e) => { const [k, v] = e.split(':'); return [parseInt(k, 16), v.split(',').map((h) => parseInt(h, 16))]; }));
  const m = fold.get(cp);
  if (m) return String.fromCodePoint(...m);
  if (cp >= 0x13a0 && cp <= 0x13f5) return String.fromCodePoint(cp);
  if (cp >= 0x13f8 && cp <= 0x13fd) return String.fromCodePoint(cp - 8);
  if (cp >= 0xab70 && cp <= 0xabbf) return String.fromCodePoint(cp - 0xab70 + 0x13a0);
  if (cp >= 0x1f80 && cp <= 0x1faf) return String.fromCodePoint(BASE[cp & ~7] + (cp & 7), 0x3b9);
  return String.fromCodePoint(cp).toLowerCase();
}
export const relpathKey = (p: string): string => { let o = ''; for (const c of p.normalize('NFC')) o += foldCp(c.codePointAt(0)!); return o; };

/** The walk skips these at every level of the folder, the way the helper's _hidden does: dot
 * names, Office lock files (~$*) and the OS clutter names, whether they are files or folders. */
export function isHidden(path: string): boolean {
  return path.split('/').some((s) => s.startsWith('.') || s.startsWith('~$') || CLUTTER.has(s.toLowerCase()));
}

export function pathOf(f: File): string {
  const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
  return (rel && rel.length ? rel : f.name).normalize('NFC');
}

function mimeOf(f: File, path: string): string {
  if (f.type) return f.type;
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME[ext] ?? 'application/octet-stream';
}

export function plan(files: Iterable<File>, already: PickedFile[] = []): Plan {
  const send = [...already];
  const keys = new Set(already.map((f) => relpathKey(f.path)));
  const notSent: NotSent[] = [];
  let skipped = 0;
  for (const f of files) {
    const raw = pathOf(f);
    if (isHidden(raw)) { skipped++; continue; }
    const path = safeRelpath(raw);
    if (!path) { notSent.push({ path: raw, reason: 'this name is not usable on every system' }); continue; }
    const key = relpathKey(path);
    if (RESERVED_TOP_FILES.has(key)) { notSent.push({ path, reason: 'Frontier writes this name itself' }); continue; }
    if (keys.has(key)) {
      if (!already.some((a) => relpathKey(a.path) === key)) notSent.push({ path, reason: 'another file has the same name' });
      continue;
    }
    keys.add(key);
    send.push({ path, size: f.size, mime: mimeOf(f, path), blob: f });
  }
  const total = send.reduce((n, f) => n + f.size, 0);
  let error: string | null = null;
  if (!send.length) error = 'There are no files to send in what you picked.';
  else if (send.length > MAX_FILES) error = `That is ${send.length} files; Frontier takes at most 1000 files per task. Pick a subfolder.`;
  else if (total > MAX_TOTAL_BYTES) error = 'Those files add up to more than 2 GiB. Pick a subfolder, or fewer files.';
  return { send, notSent, skipped, error, total };
}
