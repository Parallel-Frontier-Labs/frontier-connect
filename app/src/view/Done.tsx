import type { TaskPayload } from '../types';
import { DeliveredFiles, type DownloadApi } from './Files';
import { Chevron } from './icons';
import { doneCount } from './Plan';
import { Summary } from './Summary';

/** Finished: the takeaway, the summary, the delivered files, and the steps it took. */
export function Done({ payload: p, download }: { payload: TaskPayload; download?: DownloadApi }) {
  const { result } = p;
  const steps = p.plan.length ? p.plan.map((s) => s.title) : p.sections.map((s) => s.title);
  const nDone = p.plan.length ? doneCount(p.plan) : p.sections.filter((s) => s.done).length;
  return (
    <div class="fc-body fc-body-done">
      {result?.takeaway ? <p class="fc-takeaway">{result.takeaway}</p> : null}
      {result?.summary ? <Summary text={result.summary} type={result.summary_type} /> : null}
      {!result?.takeaway && !result?.summary ? <p class="fc-note">Finished.</p> : null}
      {p.deliverables.length ? <DeliveredFiles files={p.deliverables} download={download} saved={p.saved} /> : null}
      {steps.length ? (
        <details class="fc-stepsd">
          <summary>
            <span class="fc-sumchev"><Chevron dir="right" /></span>
            {`Steps (${steps.length})`}
            <span class="fc-faint">{nDone >= steps.length ? ' · all done' : ` · ${nDone} done`}</span>
          </summary>
          <ol>
            {steps.map((t, i) => <li key={i}>{t}</li>)}
          </ol>
        </details>
      ) : null}
    </div>
  );
}
