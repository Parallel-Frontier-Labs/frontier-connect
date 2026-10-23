import { read, utils } from 'xlsx';
import { MAX_COLS, MAX_ROWS, type SheetData, type SheetViewer } from './types';

export const sheet: SheetViewer = {
  parse(bytes) {
    const wb = read(bytes, { type: 'array', dense: true, cellDates: true });
    return wb.SheetNames.map((name): SheetData => {
      const all = utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false });
      const width = all.reduce((w, r) => Math.max(w, r.length), 0);
      const rows = all.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS).map((v) => (v == null ? '' : String(v))));
      return { name, rows, cutRows: all.length > MAX_ROWS, cutCols: width > MAX_COLS };
    });
  },
};

if (typeof window !== 'undefined') window.__frontierViewers = { ...window.__frontierViewers, sheet };
