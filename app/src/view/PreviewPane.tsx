import { useEffect, useRef, useState } from 'preact/hooks';
import type { SheetData } from '../../viewers/types';
import { Markdown } from '../markdown';
import type { FileBytes } from '../preview/fetchFile';
import { framedHtml, FRAME_SANDBOX } from '../preview/frame';
import { HTML_FRAME, kindOf } from '../preview/kind';
import type { loadViewer } from '../preview/loader';
import type { DownloadApi } from './Files';
import { DownloadIcon } from './icons';

export interface PreviewApi { bytes(path: string): Promise<FileBytes>; load: typeof loadViewer }

/** Whether and how the card previews a delivered file: full screen, beside the task (Claude only). */
export interface PreviewGate {
  /** Claude + fullscreen offered + tool calls + viewers available. */
  enabled: boolean;
  /** The current display mode. */
  mode: string;
  /** Ask the host for full screen: true only when it applied it. */
  open(): Promise<boolean>;
  /** Back to inline. */
  close(): Promise<void>;
  api: PreviewApi;
  safeArea?: { top: number; right: number; bottom: number; left: number };
}

export const NO_PREVIEW: PreviewGate = {
  enabled: false, mode: 'inline', open: async () => false, close: async () => {},
  api: { bytes: async () => ({ kind: 'failed', message: '' }), load: (() => Promise.reject(new Error('viewer unavailable'))) as unknown as PreviewApi['load'] },
};

type Render = (n: number, c: HTMLCanvasElement, w: number) => Promise<void>;
type Ready =
  | { k: 'sheet'; sheets: SheetData[] } | { k: 'pdf'; pages: number; render: Render }
  | { k: 'docx'; html: string } | { k: 'markdown' | 'text' | 'html'; text: string } | { k: 'image'; bytes: Uint8Array };
type State = { s: 'loading' } | { s: 'too_large' } | { s: 'none' } | { s: 'failed'; message: string } | { s: 'ready'; v: Ready };
const NOT_HERE = "Couldn't open this file here.";

export function PreviewPane({ file, api, download, onClose }: { file: { path: string; name: string }; api: PreviewApi; download: DownloadApi; onClose: () => void }) {
  const [st, setSt] = useState<State>({ s: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const current = useRef(file.path);
  current.current = file.path;
  useEffect(() => {
    const path = file.path;
    const kind = kindOf(file.name);
    const set = (v: State) => { if (current.current === path) setSt(v); };
    if (kind === 'none') { set({ s: 'none' }); return; }
    set({ s: 'loading' });
    void (async () => {
      let b: FileBytes;
      try { b = await api.bytes(path); } catch { set({ s: 'failed', message: NOT_HERE }); return; }
      if (b.kind !== 'ok') { set(b.kind === 'too_large' ? { s: 'too_large' } : { s: 'failed', message: b.message }); return; }
      try {
        if (kind === 'sheet') set({ s: 'ready', v: { k: 'sheet', sheets: (await api.load('sheet')).parse(b.bytes) } });
        else if (kind === 'pdf') { const d = await (await api.load('pdf')).open(b.bytes); set({ s: 'ready', v: { k: 'pdf', pages: d.pages, render: d.render } }); }
        else if (kind === 'docx') set({ s: 'ready', v: { k: 'docx', html: await (await api.load('docx')).toHtml(b.bytes) } });
        else if (kind === 'image') set({ s: 'ready', v: { k: 'image', bytes: b.bytes } });
        else set({ s: 'ready', v: { k: kind, text: new TextDecoder().decode(b.bytes) } });
      } catch {
        set({ s: 'failed', message: NOT_HERE });
      }
    })();
  }, [file.path, attempt]);
  return (
    <section class="fc-pv" aria-label={`Preview of ${file.name}`}>
      <header class="fc-pv-head">
        <span class="fc-pv-name" title={file.path}>{file.name}</span>
        {download.enabled ? <button type="button" class="fc-toggle" aria-label={`Download ${file.name}`} onClick={() => void download.get(file.path)}><DownloadIcon />Download</button> : null}
        <button type="button" class="fc-toggle" onClick={onClose}>Close preview</button>
      </header>
      <div class="fc-pv-body">
        {st.s === 'loading' ? <p class="fc-muted" role="status">{`Opening ${file.name}…`}</p>
          : st.s === 'too_large' ? <p class="fc-muted">This file is too large to preview (over 25 MB).</p>
          : st.s === 'none' ? <p class="fc-muted">No preview for this kind of file.</p>
          : st.s === 'failed' ? <p class="fc-err" role="alert">{st.message} <button type="button" class="fc-toggle" onClick={() => setAttempt((n) => n + 1)}>Retry</button></p>
          : <Body v={st.v} name={file.name} />}
      </div>
    </section>
  );
}

function Body({ v, name }: { v: Ready; name: string }) {
  if (v.k === 'sheet') return <Sheets sheets={v.sheets} />;
  if (v.k === 'pdf') return <Pdf pages={v.pages} render={v.render} />;
  if (v.k === 'docx') return <div class="fc-pv-doc" dangerouslySetInnerHTML={{ __html: v.html }} />;
  if (v.k === 'markdown') return <div class="fc-md"><Markdown text={v.text} /></div>;
  if (v.k === 'image') return <Img bytes={v.bytes} />;
  if (v.k === 'html') {
    return HTML_FRAME
      ? <iframe class="fc-pv-frame" sandbox={FRAME_SANDBOX} srcdoc={framedHtml(v.text)} title={name} />
      : <><p class="fc-muted">Showing this page's source. Download it to open it in your browser.</p><pre class="fc-pv-text">{v.text}</pre></>;
  }
  return <pre class="fc-pv-text">{v.text}</pre>;
}

function Sheets({ sheets }: { sheets: SheetData[] }) {
  const [i, setI] = useState(0);
  const s = sheets[i];
  if (!s) return <p class="fc-muted">This file has no sheets.</p>;
  return (
    <>
      {sheets.length > 1 ? (
        <div class="fc-pv-tabs">{sheets.map((x, n) => <button key={n} type="button" class="fc-toggle" aria-pressed={n === i} onClick={() => setI(n)}>{x.name}</button>)}</div>
      ) : null}
      {s.cutRows || s.cutCols ? <p class="fc-muted">Showing the first 2,000 rows and 100 columns.</p> : null}
      <div class="fc-pv-grid"><table><tbody>{s.rows.map((r, n) => <tr key={n}>{r.map((c, m) => <td key={m}>{c}</td>)}</tr>)}</tbody></table></div>
    </>
  );
}

function Pdf({ pages, render }: { pages: number; render: Render }) {
  const [shown, setShown] = useState(Math.min(3, pages));
  return (
    <div class="fc-pv-pdf">
      {Array.from({ length: shown }, (_, n) => <Page key={n} n={n + 1} render={render} />)}
      {shown < pages ? <button type="button" class="fc-toggle" onClick={() => setShown((s) => Math.min(s + 5, pages))}>Show more pages</button> : null}
    </div>
  );
}

function Page({ n, render }: { n: number; render: Render }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    if (ref.current) void render(n, ref.current, Math.min(ref.current.parentElement?.clientWidth || 800, 1000)).catch(() => setBad(true));
  }, [n]);
  if (bad) return <p class="fc-muted">Couldn't show this page.</p>;
  return <canvas ref={ref} aria-label={`Page ${n}`} />;
}

function Img({ bytes }: { bytes: Uint8Array }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [bad, setBad] = useState(typeof createImageBitmap !== 'function');
  useEffect(() => {
    const c = ref.current;
    if (!c || typeof createImageBitmap !== 'function') return;
    void createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>])).then((bmp) => {
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d')?.drawImage(bmp, 0, 0);
      bmp.close();
    }).catch(() => setBad(true));
  }, [bytes]);
  if (bad) return <p class="fc-muted">Couldn't show this image.</p>;
  return <canvas ref={ref} class="fc-pv-img" aria-label="Image" />;
}
