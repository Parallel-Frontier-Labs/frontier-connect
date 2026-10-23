export interface SheetData { name: string; rows: string[][]; cutRows: boolean; cutCols: boolean }
export interface SheetViewer { parse(bytes: Uint8Array): SheetData[] }
export interface PdfDoc {
  pages: number;
  /** Draws one page. `missingImages` is true when an image on it failed to decode (it is drawn blank). */
  render(page: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<{ missingImages: boolean }>;
  /** Frees the parsed document (pages, fonts, image data) once the preview is gone. */
  destroy(): Promise<void>;
}
export interface PdfViewer { open(bytes: Uint8Array): Promise<PdfDoc> }
export interface DocxViewer { toHtml(bytes: Uint8Array): Promise<string> }
export interface Viewers { sheet?: SheetViewer; pdf?: PdfViewer; docx?: DocxViewer }
export const MAX_ROWS = 2000;
export const MAX_COLS = 100;
declare global { interface Window { __frontierViewers?: Viewers } }
