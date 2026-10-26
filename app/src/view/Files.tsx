import { useMemo, useRef, useState } from 'preact/hooks';
import { allDirs, buildDelivery, findFile, firstFile, type TreeNode } from '../tree';
import type { Deliverable, Saved } from '../types';
import { NO_UPLOADS, readyText, UploadPanel, type UploadApi } from './UploadPanel';
import { DownloadNote, NO_DOWNLOADS, useDownloads, type DownloadApi } from './downloads';
import { CloudIcon, DownloadIcon, FolderIcon, TickIcon, TreeChevron } from './icons';

// The download types live in ./downloads (the preview shares them); re-exported for existing importers.
export { NO_DOWNLOADS, type DownloadApi };

const EXT_TONE: Record<string, string> = {
  pdf: 'red', xlsx: 'green', xls: 'green', csv: 'green', tsv: 'green', docx: 'navy', doc: 'navy', pptx: 'amber', html: 'navy',
};

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase().slice(0, 4) : '';
}

function Ext({ name }: { name: string }) {
  const ext = extOf(name);
  const tone = Object.prototype.hasOwnProperty.call(EXT_TONE, ext) ? EXT_TONE[ext] : 'gray';
  return <span class={`fc-ext fc-ext-${tone}`} aria-hidden="true">{ext || 'file'}</span>;
}

/** The deliverable's own path, as the task sent it (tree keys are `<index>:<path>`). */
const srcPath = (key: string) => key.slice(key.indexOf(':') + 1);

const Sep = () => <span class="fc-sep">/</span>;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The full-screen preview (hosts that offer full screen): a row click opens the file beside the task. When the
 * host refuses full screen (or does not answer in time), `onOpen` calls `refused` and the row
 * downloads the file instead. */
export interface FilePreview {
  enabled: boolean;
  onOpen(path: string, name: string, refused: () => void): void;
  openPath: string | null;
}

/**
 * The delivered files, view-only: where they are (the task's workspace), then the tree. Every listed
 * file is a deliverable, so rows carry no per-file tag and every folder starts open; the path line
 * follows the selected row. Rows select; when the host forwards the card's tool calls, each file has
 * a download button and the folder a "Download folder (.zip)" button (the host opens the link).
 * A plain nested list of buttons (folders toggle with aria-expanded, the selected file has
 * aria-current): no tree role, since the rows are ordinary tab stops.
 * When the Frontier plugin's helper has saved the files to the user's computer (`saved`), the box
 * says so ("Saved to your folder · <dir>") and the zip becomes a small "Download again (.zip)" link.
 */
export function DeliveredFiles({ files, download = NO_DOWNLOADS, saved = null, upload = NO_UPLOADS, taskId, preview }:
  { files: Deliverable[]; download?: DownloadApi; saved?: Saved | null; upload?: UploadApi; taskId?: string; preview?: FilePreview }) {
  const d = useMemo(() => buildDelivery(files), [files]);
  const dirs = useMemo(() => allDirs(d.nodes), [d]);
  const [open, setOpen] = useState<Set<string> | null>(null);
  const openSet = open ?? new Set(dirs);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = findFile(d.nodes, picked) ?? firstFile(d.nodes);
  const toggle = (path: string) => {
    const next = new Set(openSet);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOpen(next);
  };
  const segs = selected ? selected.path.split('/') : [];
  const dl = useDownloads(download);
  const folderBusy = dl.busy.has('');
  const note = dl.note;
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const announced = useRef(new Set<string>());
  const telling = useRef(false);
  const onAdded = async (paths: string[]) => {
    const fresh = paths.filter((p) => !announced.current.has(p));
    if (!taskId || telling.current || !fresh.length) return;
    telling.current = true;
    try {
      const text = readyText('more', taskId, fresh);
      const told = await upload.tell(text);
      fresh.forEach((p) => announced.current.add(p));
      setAdded(told ? 'Sent. Ask for the follow-up in the chat.' : `Sent. Tell the chat: ${text}`);
    } finally {
      telling.current = false;
    }
  };
  return (
    <section class="fc-files" aria-label="Files">
      {saved ? (
        <div class="fc-loc fc-loc-saved">
          <span class="fc-loc-icon"><TickIcon /></span>
          <div class="fc-loc-text">
            <div class="fc-loc-title fc-loc-savedtitle" title={saved.dir}>
              {'Saved to your folder · '}
              <span class="fc-strong-ink">{saved.dir}</span>
            </div>
            <div class="fc-mono fc-loc-path">
              <span class="fc-loc-root">{plural(d.fileCount, 'file')}</span>
            </div>
          </div>
          {download.enabled ? (
            <button type="button" class="fc-toggle fc-dlagain" aria-disabled={folderBusy ? 'true' : undefined}
              aria-busy={folderBusy ? 'true' : undefined} onClick={() => void dl.run(null, 'the folder')}>
              {folderBusy ? 'Preparing…' : 'Download again (.zip)'}
            </button>
          ) : null}
        </div>
      ) : (
        <div class="fc-loc">
          <span class="fc-loc-icon"><CloudIcon /></span>
          <div class="fc-loc-text">
            <div class="fc-loc-title">In this task's workspace</div>
            <div class="fc-mono fc-loc-path">
              <span>Workspace</span>
              <Sep />
              {d.root ? (
                <>
                  <span class="fc-loc-root">{d.root}/</span>
                  <span class="fc-chip-new">NEW FOLDER</span>
                </>
              ) : (
                <span class="fc-loc-root">{plural(d.fileCount, 'file')}</span>
              )}
            </div>
          </div>
          {download.enabled ? (
            <button type="button" class="fc-secondary fc-secondary-sm fc-dlall" aria-disabled={folderBusy ? 'true' : undefined}
              aria-busy={folderBusy ? 'true' : undefined} onClick={() => void dl.run(null, 'the folder')}>
              <DownloadIcon />
              {folderBusy ? 'Preparing…' : 'Download folder (.zip)'}
            </button>
          ) : (
            <span class="fc-loc-hint"><DownloadIcon />Open in Frontier to download</span>
          )}
        </div>
      )}
      <DownloadNote note={note} retry={dl.run} />
      <div class="fc-files-bar">
        <h3 class="fc-cap">{`Files · ${d.fileCount}`}</h3>
        {d.nested ? (
          <span class="fc-tbtns">
            <button type="button" class="fc-tbtn" onClick={() => setOpen(new Set(dirs))}>Expand all</button>
            <span class="fc-tbar" aria-hidden="true" />
            <button type="button" class="fc-tbtn" onClick={() => setOpen(new Set())}>Collapse</button>
          </span>
        ) : null}
      </div>
      {upload.enabled && taskId ? (
        <>
          {adding ? <UploadPanel taskId={taskId} api={upload} onSent={(p) => void onAdded(p)} />
            : <button type="button" class="fc-toggle" aria-label="Add files to this task" onClick={() => setAdding(true)}>Add files</button>}
          {added ? <p class="fc-note" role="status">{added}</p> : null}
        </>
      ) : null}
      <div class="fc-treebox">
        <ul class="fc-tree" aria-label="Delivered files">
          <Rows nodes={d.nodes} depth={0} nested={d.nested} openSet={openSet} selected={selected?.key ?? null} onToggle={toggle} onSelect={setPicked}
            onDownload={download.enabled ? (path, name) => void dl.run(path, name) : undefined} busy={dl.busy}
            preview={preview?.enabled ? { ...preview, onOpen: (path, name) => preview.onOpen(path, name, () => {
              if (download.enabled) void dl.run(path, name);
            }) } : undefined} />
        </ul>
        {selected ? (
          <div class="fc-mono fc-pathline" title={selected.path}>
            Workspace
            {segs.map((s, i) => (
              <span key={i}>
                <Sep />
                <span class={i === segs.length - 1 ? 'fc-strong-ink' : undefined}>{s}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Rows(props: {
  nodes: TreeNode[];
  depth: number;
  nested: boolean;
  openSet: Set<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (key: string) => void;
  onDownload?: (path: string, name: string) => void;
  busy: ReadonlySet<string>;
  preview?: FilePreview;
}) {
  const { nodes, depth, nested, openSet, selected, onToggle, onSelect, onDownload, busy, preview } = props;
  // While a file is open in the preview, its row is the current one.
  const current = (key: string) => (preview?.openPath != null ? preview.openPath === srcPath(key) : selected === key);
  const pad = 10 + depth * 22;
  return (
    <>
      {nodes.map((n) =>
        n.kind === 'dir' ? (
          <li key={`d:${n.path}`}>
            <button type="button" class="fc-trow" style={{ paddingLeft: `${pad}px` }} aria-expanded={openSet.has(n.path)} onClick={() => onToggle(n.path)}>
              <TreeChevron open={openSet.has(n.path)} />
              <FolderIcon />
              <span class="fc-tname">{n.name}/</span>
              <span class="fc-tsz">{plural(n.fileCount, 'file')}</span>
            </button>
            {openSet.has(n.path) ? (
              <ul>
                <Rows {...props} nodes={n.children} depth={depth + 1} />
              </ul>
            ) : null}
          </li>
        ) : (
          <li key={n.key} class={onDownload ? 'fc-tfile' : undefined}>
            <button type="button" class="fc-trow" style={{ paddingLeft: `${nested ? pad + 22 : pad}px` }} data-path={srcPath(n.key)}
              aria-current={current(n.key) ? 'true' : undefined}
              onClick={() => { onSelect(n.key); if (preview?.enabled) preview.onOpen(srcPath(n.key), n.name, () => {}); }}>
              <Ext name={n.name} />
              <span class="fc-tname" title={n.name}>{n.name}</span>
            </button>
            {onDownload ? ((src) => (
              <button type="button" class="fc-dl" aria-label={busy.has(src) ? `Preparing ${n.name}` : `Download ${n.name}`}
                title={busy.has(src) ? 'Preparing…' : 'Download'} aria-disabled={busy.has(src) ? 'true' : undefined}
                aria-busy={busy.has(src) ? 'true' : undefined} onClick={() => onDownload(src, n.name)}>
                {busy.has(src) ? <span class="fc-dlspin" aria-hidden="true" /> : <DownloadIcon />}
              </button>
            ))(srcPath(n.key)) : null}
          </li>
        ),
      )}
    </>
  );
}
