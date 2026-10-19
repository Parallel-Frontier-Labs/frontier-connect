import { useMemo, useState } from 'preact/hooks';
import { allDirs, buildDelivery, findFile, firstFile, type TreeNode } from '../tree';
import type { Deliverable } from '../types';
import { CloudIcon, DownloadIcon, FolderIcon, TreeChevron } from './icons';

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

const Sep = () => <span class="fc-sep">/</span>;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * The delivered files, view-only: where they are (the task's workspace), then the tree. Every listed
 * file is a deliverable, so rows carry no per-file tag and every folder starts open; the path line
 * follows the selected row. Downloads happen in Frontier, so rows select but never open or link.
 * A plain nested list of buttons (folders toggle with aria-expanded, the selected file has
 * aria-current): no tree role, since the rows are ordinary tab stops.
 */
export function DeliveredFiles({ files }: { files: Deliverable[] }) {
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
  return (
    <section class="fc-files" aria-label="Files">
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
        <span class="fc-loc-hint"><DownloadIcon />Open in Frontier to download</span>
      </div>
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
      <div class="fc-treebox">
        <ul class="fc-tree" aria-label="Delivered files">
          <Rows nodes={d.nodes} depth={0} nested={d.nested} openSet={openSet} selected={selected?.key ?? null} onToggle={toggle} onSelect={setPicked} />
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
}) {
  const { nodes, depth, nested, openSet, selected, onToggle, onSelect } = props;
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
          <li key={n.key}>
            <button type="button" class="fc-trow" style={{ paddingLeft: `${nested ? pad + 22 : pad}px` }}
              aria-current={selected === n.key ? 'true' : undefined} onClick={() => onSelect(n.key)}>
              <Ext name={n.name} />
              <span class="fc-tname" title={n.name}>{n.name}</span>
            </button>
          </li>
        ),
      )}
    </>
  );
}
