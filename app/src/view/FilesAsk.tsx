import type { OpenAsk } from '../types';
import { FileIcon } from './icons';
import { useSend, type SendProps } from './useSend';

/** The engine's folder-request question id; "Skip" answers it with a plain no. */
export const FILES_SKIP = [{ questionId: 'folder', kind: 'confirm', value: false }];

/** The task needs a file. The card has no upload yet: attach it in the chat, or skip. */
export function FilesAsk({ ask, canSend, send, onSent }: { ask: OpenAsk } & SendProps) {
  const { busy, error, submit } = useSend({ send, onSent }, ask.ask_id ?? '');
  const text = ask.text?.trim() || 'Frontier needs a file to carry on.';
  return (
    <section class="fc-askbox" aria-label="Frontier needs a file">
      <div class="fc-askhead">
        <FileIcon />
        <span>Frontier needs a file</span>
      </div>
      <h3 class="fc-legend fc-legend-sm">{text}</h3>
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
        <span class="fc-muted">{canSend ? 'or attach it in the chat' : 'Attach it in the chat.'}</span>
      </div>
      {error ? <p class="fc-err" role="alert">{error}</p> : null}
    </section>
  );
}
