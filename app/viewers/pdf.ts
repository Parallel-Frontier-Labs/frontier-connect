import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import * as worker from 'pdfjs-dist/build/pdf.worker.mjs';
import type { PdfViewer } from './types';

// Run pdf.js on the page itself: hosts may refuse a cross-origin worker, and the card loads one file.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;

export const pdf: PdfViewer = {
  async open(bytes) {
    const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: false }).promise;
    return {
      pages: doc.numPages,
      async render(n, canvas, cssWidth) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const ratio = window.devicePixelRatio || 1;
        const vp = page.getViewport({ scale: (cssWidth / base.width) * ratio });
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = `${cssWidth}px`;
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
      },
    };
  },
};

window.__frontierViewers = { ...window.__frontierViewers, pdf };
