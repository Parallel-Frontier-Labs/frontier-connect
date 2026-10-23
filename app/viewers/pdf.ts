import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import * as worker from 'pdfjs-dist/build/pdf.worker.mjs';
import type { PdfViewer } from './types';

// pdf.js decodes some images (JPEG 2000) only with WebAssembly, which a host's CSP may refuse. A failed
// decode draws blank, so after each render we ask pdf.js which images the page painted and whether
// each one resolved to data or to null. That sees every filter however the PDF names it, including
// names held in compressed object streams that a byte search of the file would never find.

// Run pdf.js on the page itself: hosts may refuse a cross-origin worker, and the card loads one file.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;

type Objs = { has(id: string): boolean; get(id: string): unknown };

/** Whether any image this page painted failed to decode (its object resolved to null). */
async function hasFailedImage(page: Awaited<ReturnType<Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>['getPage']>>): Promise<boolean> {
  const ops = await page.getOperatorList();
  const ids = [pdfjs.OPS.paintImageXObject, (pdfjs.OPS as Record<string, number>).paintImageXObjectRepeat].filter((o) => o !== undefined);
  const p = page as unknown as { objs: Objs; commonObjs: Objs };
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (!ids.includes(ops.fnArray[i]!)) continue;
    try {
      const id = ops.argsArray[i]?.[0];
      if (typeof id !== 'string') continue;
      const objs = id.startsWith('g_') ? p.commonObjs : p.objs;
      if (objs.has(id) && objs.get(id) === null) return true;
    } catch { /* absent or not yet resolved: not counted */ }
  }
  return false;
}

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
        return { missingImages: await hasFailedImage(page) };
      },
      async destroy() {
        await doc.destroy();
      },
    };
  },
};

window.__frontierViewers = { ...window.__frontierViewers, pdf };
