import { useRef, useState } from 'preact/hooks';
import type { DownloadOutcome, Stale } from '../bridge';
import { LINK_FAILED } from '../hostBridge';

/** Download buttons (hosts without the Frontier plugin): `get(path)` asks for a browser link for
 * one delivered file, or the zipped folder when `path` is null, and has the host open it. */
export interface DownloadApi {
  enabled: boolean;
  get(path: string | null): Promise<DownloadOutcome | Stale>;
}
export const NO_DOWNLOADS: DownloadApi = { enabled: false, get: async () => ({ kind: 'stale' }) };

/** The last download's outcome worth a line: a failure (with Retry) or a link to click. */
export type Note = { path: string | null; label: string; kind: 'failed'; message: string } | { path: string | null; label: string; kind: 'link'; url: string; name: string };

/** Download state shared by the Files list and the preview: which paths are being prepared, and
 * the last outcome worth a line. */
export function useDownloads(api: DownloadApi) {
  // Paths being prepared ('' is the folder), so each button shows its own "Preparing…".
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState<Note | null>(null);
  const live = useRef(new Set<string>());
  const run = async (path: string | null, label: string) => {
    const k = path ?? '';
    if (live.current.has(k)) return;
    live.current.add(k);
    setBusy(new Set(live.current));
    setNote((n) => (n && (n.path ?? '') === k ? null : n));
    let out: DownloadOutcome | Stale;
    try {
      out = await api.get(path);
    } catch {
      out = { kind: 'failed', message: LINK_FAILED };
    }
    live.current.delete(k);
    setBusy(new Set(live.current));
    // Stale: the card moved on (another view, or the task was deleted); nothing to show.
    if (out.kind === 'failed') setNote({ path, label, kind: 'failed', message: out.message });
    else if (out.kind === 'link') setNote({ path, label, kind: 'link', url: out.url, name: out.name });
  };
  return { busy, note, run };
}

/** The line under a download button: the failure with Retry, or the link to click when the host did not open it. */
export function DownloadNote({ note, retry }: { note: Note | null; retry: (path: string | null, label: string) => Promise<void> }) {
  if (!note) return null;
  return note.kind === 'failed' ? (
    <p class="fc-dlnote" role="alert">
      <span class="fc-err">{note.message}</span>
      <button type="button" class="fc-toggle" aria-label={`Retry downloading ${note.label}`}
        onClick={() => void retry(note.path, note.label)}>Retry</button>
    </p>
  ) : (
    <p class="fc-dlnote" role="status">
      <span class="fc-muted">Open this link to download:</span>
      <a class="fc-dllink" href={note.url} target="_blank" rel="noopener noreferrer" download={note.name}>{note.name}</a>
    </p>
  );
}
