import { useRef, useState } from 'preact/hooks';
import { cardClass } from '../format';
import type { AddFilesPayload } from '../upload/addFiles';
import { readyText, UploadPanel, type UploadApi } from './UploadPanel';

/** frontier_add_files: the user picks files for a new (or the chat's) Frontier task; once they are
 * in, the card tells the chat so the model starts or continues the task (spec §4.1 A). */
export function AddFiles({ add, api, theme, embedded }: { add: AddFilesPayload; api: UploadApi; theme: 'light' | 'dark'; embedded: boolean }) {
  const [done, setDone] = useState<{ text: string; told: boolean } | null>(null);
  const told = useRef(false);
  const onSent = async (sent: string[]) => {
    if (told.current) return;
    told.current = true;
    const text = readyText(add.existing ? 'more' : 'new', add.task_id, sent);
    setDone({ text, told: await api.tell(text) });
  };
  return (
    <article class={cardClass(embedded)} data-theme={theme} aria-label="Frontier: add files">
      <header class="fc-head"><h2 class="fc-title">Add files for Frontier</h2></header>
      <div class="fc-body">
        {add.instruction ? <p class="fc-legend fc-legend-sm">{add.instruction}</p> : null}
        {done ? (
          <p class="fc-note" role="status">
            {done.told ? 'Files sent. Frontier is starting the task.' : `Files sent. Tell the chat your files are ready: ${done.text}`}
          </p>
        ) : (
          <UploadPanel taskId={add.task_id} instruction={add.instruction} api={api} onSent={(s) => void onSent(s)} />
        )}
      </div>
    </article>
  );
}
