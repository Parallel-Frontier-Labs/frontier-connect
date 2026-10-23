import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { sheet } from '../viewers/sheet';
import { MAX_COLS, MAX_ROWS } from '../viewers/types';

vi.mock('xlsx', async (orig) => {
  const m = await orig<typeof import('xlsx')>();
  return { ...m, read: vi.fn(m.read) };
});

describe('sheet viewer read', () => {
  it('asks SheetJS for one row past the limit, never the whole file', () => {
    const lines = Array.from({ length: MAX_ROWS * 3 }, (_, r) => `${r},x`).join('\n');
    const [s] = sheet.parse(new TextEncoder().encode(lines));
    expect(vi.mocked(XLSX.read)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sheetRows: MAX_ROWS + 1 }));
    // What came back stops at the extra row: the rest was never converted.
    const ws = vi.mocked(XLSX.read).mock.results[0]!.value.Sheets.Sheet1;
    expect(XLSX.utils.decode_range(ws['!ref']).e.r).toBe(MAX_ROWS);
    expect(s.cutRows).toBe(true);
  });
});

describe('sheet viewer columns', () => {
  const wide = (ref: string) => {
    // Data in the first 3 columns, a marker far past the limit, and a used range wider still.
    const aoa: unknown[][] = [['a', 'b', 'c'], ['1', '2', '3']];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws[XLSX.utils.encode_cell({ r: 0, c: MAX_COLS + 40 })] = { t: 's', v: 'BEYOND' };
    ws['!ref'] = ref;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Wide');
    return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  };

  it('converts only the first MAX_COLS columns of a sheet whose used range runs to XFD', () => {
    const spy = vi.spyOn(XLSX.utils, 'sheet_to_json');
    try {
      const [s] = sheet.parse(wide('A1:XFD3'));
      expect(spy).toHaveBeenCalledTimes(1);
      const opts = spy.mock.calls[0]![1] as { range: XLSX.Range };
      expect(opts.range).toEqual({ s: { r: 0, c: 0 }, e: { r: 2, c: MAX_COLS - 1 } });
      // Nothing past the limit was converted: the marker never came back from SheetJS.
      expect(JSON.stringify(spy.mock.results[0]!.value)).not.toContain('BEYOND');
      expect(s.rows.every((r) => r.length === MAX_COLS)).toBe(true);
      expect(s.rows[0].slice(0, 3)).toEqual(['a', 'b', 'c']);
      expect(s.cutCols).toBe(true);
      expect(s.cutRows).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('is not cut at exactly MAX_COLS columns', () => {
    const [s] = sheet.parse(new TextEncoder().encode(Array.from({ length: MAX_COLS }, (_, c) => `c${c}`).join(',')));
    expect(s.rows[0].length).toBe(MAX_COLS);
    expect(s.cutCols).toBe(false);
  });
});
