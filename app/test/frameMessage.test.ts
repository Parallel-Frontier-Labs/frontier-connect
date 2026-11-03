// frontier-connect/app/test/frameMessage.test.ts
import { describe, expect, it } from 'vitest';
import { FRAME_MAX_BYTES, hrefName, readFrameMessage, resolveSibling, safeName } from '../src/preview/frameMessage';

const files = [
  { name: 'Report_2026-10.html', path: 'runs/2026-10/Report_2026-10.html' },
  { name: 'Book_2026-10.xlsx', path: 'runs/2026-10/Book_2026-10.xlsx' },
  { name: 'history.json', path: 'history.json' },
  { name: 'notes.md', path: 'a/notes.md' },
  { name: 'notes.md', path: 'b/notes.md' },
];

describe('readFrameMessage', () => {
  it('accepts the three kinds and nothing else', () => {
    expect(readFrameMessage({ type: 'frontier:frame', v: 1, kind: 'file', href: 'Book.xlsx' })).toEqual({ kind: 'file', href: 'Book.xlsx' });
    expect(readFrameMessage({ type: 'frontier:frame', v: 1, kind: 'link', href: 'https://example.com/a' })).toEqual({ kind: 'link', href: 'https://example.com/a' });
    expect(readFrameMessage({ type: 'frontier:frame', v: 1, kind: 'download', name: 'x.csv', mime: 'text/csv', base64: 'YSxi' }))
      .toEqual({ kind: 'download', name: 'x.csv', mime: 'text/csv', base64: 'YSxi' });
    expect(readFrameMessage({ type: 'frontier:frame', v: 2, kind: 'file', href: 'x' })).toBeNull();
    expect(readFrameMessage({ type: 'other', v: 1, kind: 'file', href: 'x' })).toBeNull();
    expect(readFrameMessage({ type: 'frontier:frame', v: 1, kind: 'run', href: 'x' })).toBeNull();
    expect(readFrameMessage(null)).toBeNull();
    expect(readFrameMessage('frontier:frame')).toBeNull();
  });
  it('accepts only absolute http(s) links', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '//example.com', 'ftp://example.com', 'https://'])
      expect(readFrameMessage({ type: 'frontier:frame', v: 1, kind: 'link', href }), href).toBeNull();
    expect(readFrameMessage({ type: 'frontier:frame', v: 1, kind: 'link', href: 'https://e.com/' + 'a'.repeat(2100) })).toBeNull();
  });
  it('rejects malformed downloads and oversize base64', () => {
    const d = (o: object) => readFrameMessage({ type: 'frontier:frame', v: 1, kind: 'download', name: 'x', mime: 'text/csv', base64: 'AA==', ...o });
    expect(d({ base64: 'not base64!' })).toBeNull();
    expect(d({ name: 5 })).toBeNull();
    expect(d({ mime: 'x'.repeat(300) })).toBeNull();
    expect(d({ base64: 'A'.repeat(Math.ceil((FRAME_MAX_BYTES * 4) / 3) + 8) })).toBeNull();
    expect(d({ base64: '' })).toEqual({ kind: 'download', name: 'x', mime: 'text/csv', base64: '' });
  });
});

describe('safeName and hrefName', () => {
  it('keeps a base name only, without control characters', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('a\\b\\c.csv')).toBe('c.csv');
    expect(safeName('bad\u0000\u001fname.csv')).toBe('badname.csv');
    expect(safeName('   ')).toBe('download');
    expect(safeName('x'.repeat(400)).length).toBe(255);
    expect(safeName('..')).toBe('download');
    expect(safeName('.')).toBe('download');
    expect(safeName('.\u0000.')).toBe('download');
  });
  it('names a relative href by its decoded last segment', () => {
    expect(hrefName('./sub/My%20Book.xlsx?x=1#t')).toBe('My Book.xlsx');
    expect(hrefName('%E0%A4%A')).toBe('%E0%A4%A');
  });
});

describe('resolveSibling', () => {
  const from = 'runs/2026-10/Report_2026-10.html';
  it('resolves against the previewed file directory', () => {
    expect(resolveSibling(from, 'Book_2026-10.xlsx', files)?.path).toBe('runs/2026-10/Book_2026-10.xlsx');
    expect(resolveSibling(from, './Book_2026-10.xlsx?v=1#top', files)?.path).toBe('runs/2026-10/Book_2026-10.xlsx');
    expect(resolveSibling(from, '../../history.json', files)?.path).toBe('history.json');
    expect(resolveSibling(from, 'Book%5F2026-10.xlsx', files)?.path).toBe('runs/2026-10/Book_2026-10.xlsx');
  });
  it('falls back to a unique base name, never an ambiguous one', () => {
    expect(resolveSibling(from, 'other/dir/history.json', files)?.path).toBe('history.json');
    expect(resolveSibling(from, 'notes.md', files)).toBeNull();
  });
  it('never escapes the task root and refuses absolute or broken hrefs', () => {
    expect(resolveSibling(from, '../../../history.json', files)).toBeNull();
    expect(resolveSibling(from, '/history.json', files)).toBeNull();
    expect(resolveSibling(from, '%E0%A4%A', files)).toBeNull();
    expect(resolveSibling(from, '', files)).toBeNull();
    expect(resolveSibling(from, 'missing.xlsx', files)).toBeNull();
    expect(resolveSibling(from, 'https://evil.example/history.json', files)).toBeNull();
    expect(resolveSibling(from, 'javascript:/history.json', files)).toBeNull();
    expect(resolveSibling(from, '//host/history.json', files)).toBeNull();
  });
});
