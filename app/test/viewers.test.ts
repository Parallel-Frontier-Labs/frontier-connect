import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { sheet } from '../viewers/sheet';
import { docx } from '../viewers/docx';
import { sanitizeHtml } from '../viewers/sanitize';
import { MAX_COLS, MAX_ROWS } from '../viewers/types';

const xlsx = (sheets: Record<string, unknown[][]>) => {
  const wb = XLSX.utils.book_new();
  for (const [n, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), n);
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
};

describe('sheet viewer', () => {
  it('reads every sheet as display strings', () => {
    const out = sheet.parse(xlsx({ Holdings: [['Ticker', 'Value'], ['VTV', 968000]], Model: [['Equity', 0.8]] }));
    expect(out.map((s) => s.name)).toEqual(['Holdings', 'Model']);
    expect(out[0].rows).toEqual([['Ticker', 'Value'], ['VTV', '968000']]);
    expect(out[0].cutRows || out[0].cutCols).toBe(false);
  });
  it('reads CSV bytes too', () => {
    const out = sheet.parse(new TextEncoder().encode('a,b\n1,2\n'));
    expect(out[0].rows).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('cuts at the row and column limits and says so', () => {
    const big = Array.from({ length: MAX_ROWS + 5 }, (_, r) => Array.from({ length: MAX_COLS + 3 }, (_, c) => r * 1000 + c));
    const [s] = sheet.parse(xlsx({ Big: big }));
    expect(s.rows.length).toBe(MAX_ROWS);
    expect(s.rows[0].length).toBe(MAX_COLS);
    expect(s.cutRows && s.cutCols).toBe(true);
  });
});

describe('sanitizeHtml', () => {
  it('keeps document structure and safe links, drops everything active', () => {
    const out = sanitizeHtml('<h1 onclick="x()">T</h1><p style="color:red">a <a href="https://e.com/x" target="_blank">l</a> <a href="javascript:alert(1)">j</a></p>'
      + '<script>alert(1)</script><style>p{}</style><iframe src="https://e.com"></iframe><img src="data:image/png;base64,AA" onerror="x()"><img src="https://e.com/t.png"><table><tr><td>1</td></tr></table>');
    expect(out).toContain('<h1>T</h1>');
    expect(out).toContain('<a href="https://e.com/x" rel="noopener noreferrer" target="_blank">l</a>');
    expect(out).toContain('<a>j</a>');
    expect(out).toContain('<img src="data:image/png;base64,AA">');
    expect(out).toContain('<td>1</td>');
    for (const bad of ['script', 'style', 'iframe', 'onclick', 'onerror', 'javascript:', 'https://e.com/t.png']) expect(out).not.toContain(bad);
  });
});

describe('docx viewer', () => {
  it('converts a .docx to sanitised HTML', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Roth plan</w:t></w:r></w:p></w:body></w:document>');
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    expect(await docx.toHtml(bytes)).toContain('<p>Roth plan</p>');
  });
});
