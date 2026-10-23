import mammoth from 'mammoth/mammoth.browser.js';
import { sanitizeHtml } from './sanitize';
import type { DocxViewer } from './types';

export const docx: DocxViewer = {
  async toHtml(bytes) {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const r = await mammoth.convertToHtml({ arrayBuffer: ab as ArrayBuffer });
    return sanitizeHtml(r.value);
  },
};

if (typeof window !== 'undefined') window.__frontierViewers = { ...window.__frontierViewers, docx };
