import type { TaskEvent, TaskPayload } from '../types';
import { DeliveredFiles, type DownloadApi } from './Files';
import { AlertIcon, DoneDot, FailedDot, NotRunDot } from './icons';
import { currentIndex, doneCount } from './Plan';

/** Plain words for the engine's known failure codes. */
const ERROR_WORDS: Record<string, string> = {
  sandbox_unavailable: "The task's workspace wasn't available.",
  run_timeout: 'The task ran out of time.',
  connection_lost: 'The connection to the task was lost.',
};

/** The one-line reason a task failed: a known code, else the error event's text, else a generic line. */
export function failureReason(events: TaskEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== 'error') continue;
    if (e.code && Object.prototype.hasOwnProperty.call(ERROR_WORDS, e.code)) return ERROR_WORDS[e.code]!;
    if (e.text.trim()) return e.text.trim();
    break;
  }
  return 'Something went wrong while the task was running.';
}

interface Item { title: string; state: 'done' | 'failed' | 'notrun' }

/** Steps for the end states: done ones, then where it failed, then what never ran. */
function items(p: TaskPayload, failed: boolean): Item[] {
  if (p.plan.length) {
    const cur = currentIndex(p.plan);
    return p.plan.map((s, i) => ({
      title: s.title,
      state: s.status === 'done' ? 'done' : failed && i === cur ? 'failed' : 'notrun',
    }));
  }
  // Sections come from the task's own progress; the last one is marked done at a terminal state,
  // so for a failure the last section is where it stopped.
  return p.sections.map((s, i, all) => ({
    title: s.title,
    state: failed && i === all.length - 1 ? 'failed' : s.done ? 'done' : 'notrun',
  }));
}

function Steps({ list, foldAfterFailure }: { list: Item[]; foldAfterFailure: boolean }) {
  if (!list.length) return null;
  const fail = list.findIndex((x) => x.state === 'failed');
  const shown = foldAfterFailure && fail >= 0 && list.length - fail - 1 > 1 ? list.slice(0, fail + 1) : list;
  const rest = list.length - shown.length;
  return (
    <ol class="fc-mini" aria-label="Plan">
      {shown.map((x, i) =>
        x.state === 'done' ? (
          <li key={i} class="fc-mini-done"><DoneDot size={16} />{x.title}</li>
        ) : x.state === 'failed' ? (
          <li key={i} class="fc-mini-cur"><FailedDot />{x.title}</li>
        ) : (
          <li key={i} class="fc-mini-queued"><NotRunDot />{x.title}</li>
        ),
      )}
      {rest > 0 ? <li class="fc-mini-queued"><NotRunDot />{`${rest} more steps not run`}</li> : null}
    </ol>
  );
}

/** Stopped or failed: one line on why, the steps with not-run markers, and what to do next. */
export function Ended({ payload: p, download }: { payload: TaskPayload; download?: DownloadApi }) {
  const failed = p.status === 'error';
  const list = items(p, failed);
  const total = p.plan.length;
  const done = total ? doneCount(p.plan) : 0;
  const after = total ? ` after ${done} of ${total} steps` : '';
  return (
    <div class="fc-body fc-body-done">
      {failed ? (
        <div class="fc-failbox" role="alert">
          <AlertIcon />
          <div class="fc-failtext">
            <div class="fc-failtitle">Couldn't finish the task</div>
            <div class="fc-faildesc">{failureReason(p.events)}</div>
          </div>
        </div>
      ) : (
        <p class="fc-reason">{`Stopped${after}.${p.deliverables.length ? '' : ' Nothing was delivered.'}`}</p>
      )}
      <Steps list={list} foldAfterFailure={failed} />
      {p.deliverables.length ? <DeliveredFiles files={p.deliverables} download={download} saved={p.saved} /> : null}
      <div class="fc-muted fc-next">{failed ? 'Ask in the chat to try again.' : 'Ask in the chat to start it again.'}</div>
    </div>
  );
}
