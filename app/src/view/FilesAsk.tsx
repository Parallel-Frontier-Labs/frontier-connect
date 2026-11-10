import { useRef, useState } from 'preact/hooks';
import type { OpenAsk } from '../types';
import { FileIcon } from './icons';
import { NO_UPLOADS, readyText, UploadPanel, type UploadApi } from './UploadPanel';
import { useSend, type SendProps } from './useSend';

/** The engine's folder-request question id; "Skip" answers it with a plain no. */
export const FILES_SKIP = [{ questionId: 'folder', kind: 'confirm', value: false }];

/** The task needs a file: the user adds it here (the chat is then told, so the model continues the
 * task), or skips. Without card uploads: attach it in the chat. */
export function FilesAsk({ ask, canSend, send, onSent, taskId = '', upload = NO_UPLOADS }:
  { ask: OpenAsk; taskId?: string; upload?: UploadApi } & SendProps) {
  const { busy, error, submit } = useSend({ send, onSent }, ask.ask_id ?? '');
  const text = ask.text?.trim() || 'Frontier needs a file to carry on.';
  const [sent, setSent] = useState<string | null>(null);
  const [listedOnly, setListedOnly] = useState<string | null>(null);
  const announced = useRef(new Set<string>());
  const announcedListed = useRef(0);
  const telling = useRef(false);
  const onUploaded = async (paths: string[], listed: number) => {
    const fresh = paths.filter((p) => !announced.current.has(p));
    if (telling.current || (!fresh.length && listed <= announcedListed.current)) return;
    telling.current = true;
    try {
      const msg = readyText('ask', taskId, fresh, listed);
      const told = await upload.tell(msg);
      fresh.forEach((p) => announced.current.add(p));
      announcedListed.current = Math.max(announcedListed.current, listed);
      if (!fresh.length) {
        // Nothing went up (Frontier kept none of a folder): the chat knows about the listing, but
        // the request stays open so the user can still pick the file itself (always sent).
        const n = `${listed} ${listed === 1 ? 'file' : 'files'}`;
        setListedOnly(`Frontier listed ${n} but none was uploaded. Pick the file itself to send it.${told ? '' : ` Tell the chat: ${msg}`}`);
        return;
      }
      setListedOnly(null);
      setSent(told ? 'Sent. Frontier will carry on with them.' : `Sent. Tell the chat: ${msg}`);
    } finally {
      telling.current = false;
    }
  };
  return (
    <section class="fc-askbox" aria-label="Frontier needs a file">
      <div class="fc-askhead">
        <FileIcon />
        <span>Frontier needs a file</span>
      </div>
      <h3 class="fc-legend fc-legend-sm">{text}</h3>
      {!sent && listedOnly ? <p class="fc-note" role="status">{listedOnly}</p> : null}
      {sent ? <p class="fc-note" role="status">{sent}</p>
        : upload.enabled && taskId ? <UploadPanel taskId={taskId} instruction={ask.text?.trim() || undefined} api={upload} onSent={(p, l) => void onUploaded(p, l)} /> : null}
      <div class="fc-actions">
        {canSend ? (
          <button
            type="button"
            class="fc-secondary"
            disabled={busy}
            onClick={() => void submit(FILES_SKIP, { items: [{ prompt: text, options: [] }], label: 'Skipped' })}
          >
            {busy ? 'Sending…' : 'Skip'}
          </button>
        ) : null}
        {!upload.enabled ? <span class="fc-muted">{canSend ? 'or attach it in the chat' : 'Attach it in the chat.'}</span> : null}
      </div>
      {error ? <p class="fc-err" role="alert">{error}</p> : null}
    </section>
  );
}
