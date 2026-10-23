import { describe, expect, it } from 'vitest';
import fixture from './fixtures/casefold.json';
import { isHidden, MAX_FILES, plan, relpathKey, safeRelpath } from '../src/upload/manifest';

const file = (path: string, size = 3, type = '') => {
  const f = new File([new Uint8Array(size)], path.split('/').pop()!, { type });
  if (path.includes('/')) Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
};

describe('safeRelpath (the helper\'s rules)', () => {
  it('accepts plain relative paths, NFC-normalised', () => {
    expect(safeRelpath('Statements/2025/a.pdf')).toBe('Statements/2025/a.pdf');
    expect(safeRelpath('Cafe\u0301.pdf')).toBe('Café.pdf');
  });
  it('refuses unsafe paths', () => {
    for (const p of ['', '/abs.pdf', 'C:/x.pdf', 'a\\b.pdf', 'a/../b.pdf', 'a/./b', 'trail.', 'trail ',
      'CON.txt', 'x/LPT1', '.frontier/a', 'a\u0007b', 'x'.repeat(513), `${'é'.repeat(130)}.pdf`]) {
      expect(safeRelpath(p), p).toBeNull();
    }
  });
  it('relpathKey folds case', () => {
    expect(relpathKey('A.PDF')).toBe(relpathKey('a.pdf'));
  });
  it('relpathKey folds like the server casefold, so names it would call duplicates are caught here', () => {
    expect(relpathKey('Straße.pdf')).toBe(relpathKey('STRASSE.pdf'));
    expect(relpathKey('ΑΣ.pdf')).toBe(relpathKey('ας.pdf'));
  });
  it('accepts a path of 300 emoji (300 code points, 1200 UTF-8 bytes) as the server counts it', () => {
    const seg = '\u{1F600}'.repeat(60); // 60 code points, 240 bytes: each segment fits 255 bytes
    const path = [seg, seg, seg, seg, seg].join('/');
    expect(safeRelpath(path)).toBe(path);
  });
});

describe('isHidden', () => {
  it('skips dot files and folders, Office locks and OS clutter', () => {
    for (const p of ['test/.DS_Store', '.git/config', 'a/.hidden/b.pdf', '~$Budget.xlsx', 'x/Thumbs.db', 'desktop.ini']) {
      expect(isHidden(p), p).toBe(true);
    }
    expect(isHidden('test/Financial Plan.pdf')).toBe(false);
  });
});

describe('plan', () => {
  it('keeps visible files with real sizes and a mime, and counts hidden ones as skipped', () => {
    const p = plan([file('test/Financial Plan.pdf', 10, 'application/pdf'), file('test/.DS_Store', 6), file('test/notes.csv', 4)]);
    expect(p.error).toBeNull();
    expect(p.send.map((f) => [f.path, f.size, f.mime])).toEqual([
      ['test/Financial Plan.pdf', 10, 'application/pdf'], ['test/notes.csv', 4, 'text/csv']]);
    expect(p.skipped).toBe(1);
    expect(p.total).toBe(14);
  });
  it('never sends reserved top-level names, unsafe or duplicate paths, and says why', () => {
    const p = plan([file('context.md'), file('a/folder-index.md'), file('CON.txt'), file('x/A.pdf'), file('x/a.pdf')]);
    expect(p.send.map((f) => f.path)).toEqual(['a/folder-index.md', 'x/A.pdf']);
    expect(p.notSent).toEqual([
      { path: 'context.md', reason: 'Frontier writes this name itself' },
      { path: 'CON.txt', reason: 'this name is not usable on every system' },
      { path: 'x/a.pdf', reason: 'another file has the same name' },
    ]);
  });
  it('treats names that casefold alike as duplicates, as the server does', () => {
    const p = plan([file('Straße.pdf'), file('STRASSE.pdf')]);
    expect(p.send.map((f) => f.path)).toEqual(['Straße.pdf']);
    expect(p.notSent).toEqual([{ path: 'STRASSE.pdf', reason: 'another file has the same name' }]);
  });
  it('adds to an earlier pick without duplicating it', () => {
    const first = plan([file('a.pdf')]);
    const p = plan([file('a.pdf'), file('b.pdf')], first.send);
    expect(p.send.map((f) => f.path)).toEqual(['a.pdf', 'b.pdf']);
  });
  it('refuses more than the per-task caps before anything is sent', () => {
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`f/${i}.txt`, 1));
    expect(plan(many).error).toMatch(/at most 1000 files/);
    const big = file('big.bin', 1);
    Object.defineProperty(big, 'size', { value: 2 * 1024 ** 3 + 1 });
    expect(plan([big]).error).toMatch(/more than 2 GiB/);
  });
  it('says so when nothing is left to send', () => {
    expect(plan([file('x/.DS_Store')]).error).toBe('There are no files to send in what you picked.');
  });
});

describe('relpathKey matches the server casefold exactly', () => {
  it('folds every fixture code point like Python casefold', () => {
    const bad = Object.entries(fixture.chars as Record<string, string>)
      .filter(([hex, want]) => relpathKey(String.fromCodePoint(parseInt(hex, 16))) !== want).map(([hex]) => hex);
    expect(bad).toEqual([]);
  });
  it('folds the fixture names', () => {
    for (const [name, want] of Object.entries(fixture.names as Record<string, string>)) expect(relpathKey(name)).toBe(want);
  });
  it('plan: sharp s and capital sharp s are one name; dotless i and I are two', () => {
    const a = plan([file('Straße.pdf'), file('STRAẞE.pdf')]);
    expect(a.send.map((f) => f.path)).toEqual(['Straße.pdf']);
    expect(a.notSent).toEqual([{ path: 'STRAẞE.pdf', reason: 'another file has the same name' }]);
    expect(plan([file('ı.pdf'), file('I.pdf')]).send.map((f) => f.path)).toEqual(['ı.pdf', 'I.pdf']);
  });
});
