import { useEffect, useRef, useState } from 'preact/hooks';
import type { Deliverable } from '../types';
import type { PdfDoc, SheetData } from '../../viewers/types';
import { Markdown } from '../markdown';
import type { FileBytes } from '../preview/fetchFile';
import { framedHtml, FRAME_SANDBOX } from '../preview/frame';
import { HTML_FRAME, kindOf } from '../preview/kind';
import { hrefName, readFrameMessage, resolveSibling, safeName, type FrameMessage } from '../preview/frameMessage';
import type { loadViewer } from '../preview/loader';
import { DownloadNote, useDownloads, type DownloadApi } from './downloads';
import { DownloadIcon } from './icons';

export interface PreviewApi {
  bytes(path: string): Promise<FileBytes>;
  load: typeof loadViewer;
  /** The host's ui/open-link: true when it opened the URL. */
  openLink(url: string): Promise<boolean>;
  /** The host's ui/download-file for bytes the card holds: true when the host accepted. */
  saveBytes(name: string, mime: string, base64: string): Promise<boolean>;
}

export const PAGE_DOWNLOAD_UNAVAILABLE = "This page's download isn't available here.";
/** The card's own question before a page's web link leaves: the frame and its activation are untrusted. */
export const LINK_CONFIRM = 'This page wants to open';
/** Open link stays disabled this long after the address appears or changes, so a page cannot swap it under the click. */
export const LINK_CONFIRM_ARM_MS = 750;
export const notFoundLine = (name: string) => `Couldn't find ${name} among this task's files.`;

/** Whether and how the card previews a delivered file: full screen, beside the task (hosts that offer full screen). */
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
  api: {
    bytes: async () => ({ kind: 'failed', message: '' }),
    load: (() => Promise.reject(new Error('viewer unavailable'))) as unknown as PreviewApi['load'],
    openLink: async () => false,
    saveBytes: async () => false,
  },
};

type FrameNote = { kind: 'text'; text: string } | { kind: 'link'; url: string } | { kind: 'confirm'; url: string };

type Render = (n: number, c: HTMLCanvasElement, w: number) => Promise<{ missingImages: boolean } | void>;
type Ready =
  | { k: 'sheet'; sheets: SheetData[] } | { k: 'pdf'; pages: number; render: Render }
  | { k: 'docx'; html: string } | { k: 'markdown' | 'text' | 'html'; text: string } | { k: 'image'; bytes: Uint8Array };
type State = { s: 'loading' } | { s: 'too_large' } | { s: 'none' } | { s: 'failed'; message: string } | { s: 'ready'; v: Ready };
const NOT_HERE = "Couldn't open this file here.";

export function PreviewPane({ file, files = [], api, download, onClose }: { file: { path: string; name: string }; files?: Deliverable[]; api: PreviewApi; download: DownloadApi; onClose: () => void }) {
  const [st, setSt] = useState<State>({ s: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // The same download states as the Files list: Preparing…, a failure with Retry, or a link to click.
  const dl = useDownloads(download);
  const preparing = dl.busy.has(file.path);
  const note = dl.note;
  const current = useRef(file.path);
  current.current = file.path;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [frameNote, setFrameNote] = useState<FrameNote | null>(null);
  const acting = useRef(false);
  // Latest props for the listener, which is registered once per file.
  const ctx = useRef({ files, api, run: dl.run });
  ctx.current = { files, api, run: dl.run };
  useEffect(() => {
    const perform = async (m: FrameMessage) => {
      const { files: fs, api: a, run } = ctx.current;
      setFrameNote(null);
      if (m.kind === 'file') {
        const hit = resolveSibling(file.path, m.href, fs);
        if (!hit) { setFrameNote({ kind: 'text', text: notFoundLine(hrefName(m.href)) }); return; }
        await run(hit.path, hit.name);
      } else if (m.kind === 'link') {
        // Never open from the message: opening the preview leaves the card activated, so a page could
        // post on load. Only the card's Open link button (a gesture in the card) reaches ui/open-link.
        setFrameNote({ kind: 'confirm', url: m.href });
      } else {
        const ok = m.base64 ? await a.saveBytes(safeName(m.name), m.mime || 'application/octet-stream', m.base64) : false;
        if (!ok) setFrameNote({ kind: 'text', text: PAGE_DOWNLOAD_UNAVAILABLE });
      }
    };
    const onMessage = (e: MessageEvent) => {
      const f = frameRef.current;
      if (!f || e.source !== f.contentWindow) return;
      const m = readFrameMessage(e.data);
      if (!m || acting.current) return;
      // The frame's own gate is a courtesy, not a boundary: page script can post too.
      if ((navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive === false) return;
      acting.current = true;
      void perform(m).catch(() => {}).finally(() => { acting.current = false; });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [file.path]);
  // Armed for one address only, so a swapped address renders disabled at once (no effect lag).
  const [armedUrl, setArmedUrl] = useState<string | null>(null);
  const confirmUrl = frameNote && frameNote.kind === 'confirm' ? frameNote.url : null;
  const armed = confirmUrl !== null && armedUrl === confirmUrl;
  useEffect(() => {
    setArmedUrl(null);
    if (confirmUrl === null) return;
    const t = setTimeout(() => setArmedUrl(confirmUrl), LINK_CONFIRM_ARM_MS);
    return () => clearTimeout(t);
  }, [confirmUrl]);
  const openConfirmed = async (url: string) => {
    if (!armed) return;
    setFrameNote(null);
    let ok = false;
    try { ok = await ctx.current.api.openLink(url); } catch { ok = false; }
    if (!ok) setFrameNote({ kind: 'link', url });
  };
  useEffect(() => {
    const path = file.path;
    const kind = kindOf(file.name);
    const set = (v: State) => { if (current.current === path) setSt(v); };
    if (kind === 'none') { set({ s: 'none' }); return; }
    set({ s: 'loading' });
    // The open PDF, freed when this file's view goes (another file, a retry, the pane closing).
    let live = true;
    let doc: PdfDoc | null = null;
    void (async () => {
      let b: FileBytes;
      try { b = await api.bytes(path); } catch { set({ s: 'failed', message: NOT_HERE }); return; }
      if (b.kind !== 'ok') { set(b.kind === 'too_large' ? { s: 'too_large' } : { s: 'failed', message: b.message }); return; }
      try {
        if (kind === 'sheet') set({ s: 'ready', v: { k: 'sheet', sheets: (await api.load('sheet')).parse(b.bytes) } });
        else if (kind === 'pdf') {
          const d = await (await api.load('pdf')).open(b.bytes);
          if (!live) { freePdf(d); return; }
          doc = d;
          set({ s: 'ready', v: { k: 'pdf', pages: d.pages, render: d.render } });
        }
        else if (kind === 'docx') set({ s: 'ready', v: { k: 'docx', html: await (await api.load('docx')).toHtml(b.bytes) } });
        else if (kind === 'image') set({ s: 'ready', v: { k: 'image', bytes: b.bytes } });
        else set({ s: 'ready', v: { k: kind, text: new TextDecoder().decode(b.bytes) } });
      } catch {
        set({ s: 'failed', message: NOT_HERE });
      }
    })();
    return () => {
      live = false;
      if (doc) freePdf(doc);
      doc = null;
    };
  }, [file.path, attempt]);
  return (
    <section class="fc-pv" aria-label={`Preview of ${file.name}`}>
      <header class="fc-pv-head">
        <span class="fc-pv-name" title={file.path}>{file.name}</span>
        {download.enabled ? (
          <button type="button" class="fc-toggle" aria-label={preparing ? `Preparing ${file.name}` : `Download ${file.name}`}
            aria-disabled={preparing ? 'true' : undefined} aria-busy={preparing ? 'true' : undefined}
            onClick={() => void dl.run(file.path, file.name)}>
            <DownloadIcon />{preparing ? 'Preparing…' : 'Download'}
          </button>
        ) : null}
        <button type="button" class="fc-toggle" onClick={onClose}>Close preview</button>
      </header>
      {note ? <div class="fc-pv-dl"><DownloadNote note={note} retry={dl.run} /></div> : null}
      {frameNote ? (
        <div class="fc-pv-dl">
          {frameNote.kind === 'text'
            ? <p class="fc-dlnote" role="status"><span class="fc-muted">{frameNote.text}</span></p>
            : frameNote.kind === 'confirm'
            ? <p class="fc-dlnote" role="status"><span class="fc-muted">{LINK_CONFIRM}</span> <code class="fc-pv-url">{frameNote.url}</code>{' '}
                <button type="button" class="fc-toggle" disabled={!armed} aria-disabled={armed ? undefined : 'true'} onClick={() => void openConfirmed(frameNote.url)}>Open link</button>{' '}
                <button type="button" class="fc-toggle" onClick={() => setFrameNote(null)}>Cancel</button></p>
            : <p class="fc-dlnote" role="status"><span class="fc-muted">Open this link:</span> <a class="fc-dllink" href={frameNote.url} target="_blank" rel="noopener noreferrer">{frameNote.url}</a></p>}
        </div>
      ) : null}
      <div class="fc-pv-body">
        {st.s === 'loading' ? <p class="fc-muted" role="status">{`Opening ${file.name}…`}</p>
          : st.s === 'too_large' ? <p class="fc-muted">This file is too large to preview (over 25 MB).</p>
          : st.s === 'none' ? <p class="fc-muted">No preview for this kind of file.</p>
          : st.s === 'failed' ? <p class="fc-err" role="alert">{st.message} <button type="button" class="fc-toggle" onClick={() => setAttempt((n) => n + 1)}>Retry</button></p>
          : <Body v={st.v} name={file.name} frameRef={frameRef} />}
      </div>
    </section>
  );
}

function freePdf(d: PdfDoc) {
  try { void Promise.resolve(d.destroy?.()).catch(() => {}); } catch { /* already gone */ }
}

function Body({ v, name, frameRef }: { v: Ready; name: string; frameRef: { current: HTMLIFrameElement | null } }) {
  if (v.k === 'sheet') return <Sheets sheets={v.sheets} />;
  if (v.k === 'pdf') return <Pdf pages={v.pages} render={v.render} />;
  if (v.k === 'docx') return <div class="fc-pv-doc" dangerouslySetInnerHTML={{ __html: v.html }} />;
  if (v.k === 'markdown') return <div class="fc-md"><Markdown text={v.text} /></div>;
  if (v.k === 'image') return <Img bytes={v.bytes} />;
  if (v.k === 'html') {
    return HTML_FRAME
      ? <iframe ref={frameRef} class="fc-pv-frame" sandbox={FRAME_SANDBOX} srcdoc={framedHtml(v.text)} title={name} />
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
  const [missingImages, setMissing] = useState(false);
  return (
    <div class="fc-pv-pdf">
      {missingImages ? <p class="fc-muted">Some images in this PDF can't be shown here. Download it to see them.</p> : null}
      {Array.from({ length: shown }, (_, n) => <Page key={n} n={n + 1} render={render} onMissingImages={() => setMissing(true)} />)}
      {shown < pages ? <button type="button" class="fc-toggle" onClick={() => setShown((s) => Math.min(s + 5, pages))}>Show more pages</button> : null}
    </div>
  );
}

function Page({ n, render, onMissingImages }: { n: number; render: Render; onMissingImages: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    if (ref.current) void render(n, ref.current, Math.min(ref.current.parentElement?.clientWidth || 800, 1000))
      .then((r) => { if (r && r.missingImages) onMissingImages(); }).catch(() => setBad(true));
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
