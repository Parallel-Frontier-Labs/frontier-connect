import { useRef, useState } from 'preact/hooks';
import { plan, type PickedFile, type Plan } from '../upload/manifest';
import type { Progress, SendResult } from '../upload/transfer';
import { FileIcon, FolderIcon } from './icons';

export interface UploadApi {
  enabled: boolean;
  send(taskId: string, files: PickedFile[], onProgress?: (p: Progress) => void, instruction?: string): Promise<SendResult>;
  tell(text: string): Promise<boolean>;
}
export const NO_UPLOADS: UploadApi = {
  enabled: false,
  send: async () => ({ sent: [], failed: [], error: 'Attach the files in the chat instead.' }),
  tell: async () => false,
};

const SHOWN = 8;

export function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** The top-level names of what was sent: folders as "name/", loose files as is. */
function tops(paths: string[]): string {
  const out: string[] = [];
  for (const p of paths) {
    const t = p.includes('/') ? `${p.split('/')[0]}/` : p;
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, 5).join(', ') + (out.length > 5 ? ', …' : '');
}

const LOOKUP = "if that tool isn't loaded yet, look it up by that exact name";

/** The message the card posts so the model takes the next step (spec §4.1). It names the tool
 *  exactly: hosts that defer MCP tools (Claude, Cowork) load a tool by name or by keyword search,
 *  and "Start the Frontier task" alone led Claude to load only the picker and give up. */
export function readyText(kind: 'new' | 'ask' | 'more', taskId: string, sent: string[]): string {
  const n = sent.length;
  const files = n === 1 ? 'file' : 'files';
  if (kind === 'new') return `I added ${n} ${files} for Frontier (${tops(sent)}). upload_id: ${taskId}. Call frontier_start_task with this upload_id (${LOOKUP}); the files are already attached, so don't list them.`;
  if (kind === 'ask') return `I added the ${files} Frontier asked for (${tops(sent)}) to task ${taskId}. Call frontier_continue_task for ${taskId} (${LOOKUP}).`;
  return `I added ${n} new ${files} to the Frontier task ${taskId} (${tops(sent)}). Call frontier_continue_task for ${taskId} (${LOOKUP}).`;
}

export function UploadPanel({ taskId, instruction, api, sendLabel = 'Send to Frontier', onSent }: {
  taskId: string; instruction?: string; api: UploadApi; sendLabel?: string; onSent: (sent: string[]) => void;
}) {
  const [picked, setPicked] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<Progress | null>(null);
  const [failed, setFailed] = useState<{ path: string; reason: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sentSoFar = useRef<Set<string>>(new Set());
  const inFlight = useRef(false);
  const pickedRef = useRef<Plan | null>(null);
  const [, setSentCount] = useState(0);
  const folder = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  if (!api.enabled) return <p class="fc-muted">Attach the files in the chat instead.</p>;

  const put = (p: Plan | null) => { pickedRef.current = p; setPicked(p); };
  const add = (list: FileList | File[] | null | undefined) => {
    if (!list || !list.length || inFlight.current) return;
    setError(null);
    setFailed([]);
    put(plan(Array.from(list), pickedRef.current?.send ?? []));
  };
  const clear = () => { setError(null); setFailed([]); put(null); };
  const run = async (toSend: PickedFile[]) => {
    if (inFlight.current || !toSend.length) return;
    inFlight.current = true;
    try {
      setError(null);
      setBusy({ done: 0, total: toSend.length, failed: 0 });
      const r = await api.send(taskId, toSend, setBusy, instruction);
      if (r.error) { setError(r.error); return; }
      for (const path of r.sent) sentSoFar.current.add(path);
      setSentCount(sentSoFar.current.size);
      setFailed(r.failed);
      if (!r.failed.length && !pending().length) onSent([...sentSoFar.current]);
    } catch {
      setError('The upload stopped unexpectedly. Try again.');
    } finally {
      setBusy(null);
      inFlight.current = false;
    }
  };
  const pending = () => (pickedRef.current?.send ?? []).filter((f) => !sentSoFar.current.has(f.path));
  const retry = () => {
    const paths = new Set(failed.map((f) => f.path));
    void run((pickedRef.current?.send ?? []).filter((f) => paths.has(f.path)));
  };
  const p = picked;
  return (
    <section class="fc-upload" aria-label="Add files for Frontier">
      <div class="fc-actions">
        <button type="button" class="fc-secondary" disabled={!!busy} onClick={() => folder.current?.click()}><FolderIcon />Add folder</button>
        <button type="button" class="fc-secondary" disabled={!!busy} onClick={() => files.current?.click()}><FileIcon />Add files</button>
        <input ref={folder} type="file" hidden multiple {...{ webkitdirectory: '', directory: '' }} onChange={(e) => { add((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ''; }} />
        <input ref={files} type="file" hidden multiple onChange={(e) => { add((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ''; }} />
      </div>
      <div class="fc-drop" aria-disabled={busy ? 'true' : 'false'} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); add(e.dataTransfer?.files); }}>
        <span class="fc-muted">Or drop files here</span>
      </div>
      {p ? (
        <div class="fc-upl-list">
          <div class="fc-cap">{`${p.send.length} ${p.send.length === 1 ? 'file' : 'files'} · ${size(p.total)}`}</div>
          <ul>{p.send.slice(0, SHOWN).map((f) => <li key={f.path} class="fc-mono">{f.path}{sentSoFar.current.has(f.path) ? <span class="fc-muted"> · Sent</span> : null}</li>)}</ul>
          {p.send.length > SHOWN ? <div class="fc-muted">{`and ${p.send.length - SHOWN} more`}</div> : null}
          {p.skipped ? <div class="fc-muted">{`${p.skipped} hidden ${p.skipped === 1 ? 'file' : 'files'} skipped`}</div> : null}
          {p.notSent.map((n) => <div key={n.path} class="fc-muted">{`Not sent: ${n.path} (${n.reason})`}</div>)}
        </div>
      ) : null}
      <div aria-live="polite">
        {busy ? (
          <p class="fc-muted">
            <span aria-hidden="true">{`Sending ${busy.done} of ${busy.total}…`}</span>
            <span class="fc-sr">{`Sending ${busy.total} ${busy.total === 1 ? 'file' : 'files'}…`}</span>
          </p>
        ) : null}
      </div>
      {failed.length ? (
        <div role="alert" class="fc-err">
          {failed.map((f) => <div key={f.path}>{`${f.path}: ${f.reason}`}</div>)}
          <button type="button" class="fc-toggle" disabled={!!busy} onClick={retry}>Retry</button>
        </div>
      ) : null}
      {p?.error || error ? <p role="alert" class="fc-err">{error ?? p!.error}</p> : null}
      {p && !p.error && !failed.length && pending().length ? (
        <button type="button" class="fc-primary" disabled={!!busy} onClick={() => void run(pending())}>{sendLabel}</button>
      ) : null}
      {p && !busy ? <button type="button" class="fc-toggle" onClick={clear}>Clear</button> : null}
    </section>
  );
}
