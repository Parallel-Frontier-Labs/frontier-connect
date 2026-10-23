import { read, utils } from 'xlsx';
import { MAX_COLS, MAX_ROWS, type SheetData, type SheetViewer } from './types';

export const sheet: SheetViewer = {
  parse(bytes) {
    // Read one row past the limit and no more: a 25 MB CSV is not converted in full to show 2000 rows.
    const wb = read(bytes, { type: 'array', dense: true, cellDates: true, sheetRows: MAX_ROWS + 1 });
    return wb.SheetNames.map((name): SheetData => {
      const ws = wb.Sheets[name];
      // Convert only the first MAX_COLS columns: a sheet whose used range runs to column XFD is not
      // turned into 16,384 cells a row to show 100 (rows are already capped by sheetRows).
      const ref = ws?.['!ref'];
      const r = ref ? utils.decode_range(ref) : null;
      const range = r ? { s: r.s, e: { r: r.e.r, c: Math.min(r.e.c, r.s.c + MAX_COLS - 1) } } : undefined;
      const all = utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '', blankrows: false, range });
      const rows = all.slice(0, MAX_ROWS).map((row) => row.slice(0, MAX_COLS).map((v) => (v == null ? '' : String(v))));
      // Cut when more than MAX_ROWS rows were read, or the read reached the extra row (blank rows,
      // which are skipped, may sit before it; rows past it were never read).
      const reached = r ? r.e.r >= MAX_ROWS : false;
      const cutCols = r ? r.e.c - r.s.c + 1 > MAX_COLS : false;
      return { name, rows, cutRows: all.length > MAX_ROWS || reached, cutCols };
    });
  },
};

if (typeof window !== 'undefined') window.__frontierViewers = { ...window.__frontierViewers, sheet };
