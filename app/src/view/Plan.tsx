import { useState } from 'preact/hooks';
import { formatEta } from '../format';
import type { PlanStep, TaskPayload } from '../types';
import { Chevron, DoneDot, Ellipsis, Now, PausedDot, QueuedDot } from './icons';

/** A plan longer than this shows its first, current and last steps and folds the rest. */
export const LONG_PLAN = 6;

/** Index of the step being worked on: the one in progress, else the first queued one. */
export function currentIndex(plan: PlanStep[]): number {
  const i = plan.findIndex((s) => s.status === 'in_progress');
  return i >= 0 ? i : plan.findIndex((s) => s.status !== 'done');
}

export const doneCount = (plan: PlanStep[]): number => plan.filter((s) => s.status === 'done').length;

/** Changes whenever the task moves on (a step or a section): used to retire the "Answered" note. */
export const progressKey = (p: TaskPayload): string =>
  `${doneCount(p.plan)}/${p.plan.length}/${p.sections.length}/${p.sections.filter((s) => s.done).length}`;

function Meter({ plan, eta, note, right }: { plan: PlanStep[]; eta?: string | null; note?: string; right?: string | null }) {
  const done = doneCount(plan);
  return (
    <div class="fc-meter-row">
      <div class="fc-mono fc-meter-count">
        <span class="fc-strong">{`${done} of ${plan.length}`}</span> steps done{note ? ` · ${note}` : ''}
      </div>
      {eta || right ? <div class="fc-mono fc-meter-eta">{eta ?? right}</div> : null}
    </div>
  );
}

function Segments({ plan }: { plan: PlanStep[] }) {
  return (
    <div class={plan.length > 6 ? 'fc-segs fc-segs-dense' : 'fc-segs'} aria-hidden="true">
      {plan.map((s, i) => (
        <div key={i} class={`fc-seg fc-seg-${s.status}`}>
          {s.status === 'in_progress' ? <div class="fc-seg-run" /> : null}
        </div>
      ))}
    </div>
  );
}

type Row =
  | { t: 'step'; i: number }
  | { t: 'fold'; side: 'done' | 'queued'; count: number };

/** Rows of the timeline: every step, or for a long plan first / current / last with folds between. */
export function timelineRows(plan: PlanStep[], cur: number, open: { done: boolean; queued: boolean }): Row[] {
  const all: Row[] = plan.map((_, i) => ({ t: 'step', i }));
  if (plan.length <= LONG_PLAN) return all;
  const last = plan.length - 1;
  const c = cur < 0 ? last : cur;
  const rows: Row[] = [{ t: 'step', i: 0 }];
  const before = c - 1; // steps 1..c-1
  if (before >= 1) {
    if (open.done || before === 1) for (let i = 1; i < c; i++) rows.push({ t: 'step', i });
    else rows.push({ t: 'fold', side: 'done', count: before });
  }
  if (c !== 0) rows.push({ t: 'step', i: c });
  const after = last - c - 1; // steps c+1..last-1
  if (after >= 1) {
    if (open.queued || after === 1) for (let i = c + 1; i < last; i++) rows.push({ t: 'step', i });
    else rows.push({ t: 'fold', side: 'queued', count: after });
  }
  if (c !== last) rows.push({ t: 'step', i: last });
  return rows;
}

/** Running with a plan: progress meter, then the step timeline with the current step's live line. */
export function PlanProgress({ payload: p }: { payload: TaskPayload }) {
  const [open, setOpen] = useState({ done: false, queued: false });
  const plan = p.plan;
  const cur = currentIndex(plan);
  const eta = p.status === 'running' && p.estimate ? formatEta(p.estimate.eta_s) : null;
  const rows = timelineRows(plan, cur, open);
  return (
    <>
      <div class="fc-meter">
        <Meter plan={plan} eta={eta} />
        <Segments plan={plan} />
      </div>
      <div class="fc-rule" />
      <div class="fc-timeline">
        <ol class="fc-steps" aria-label="Plan">
          {rows.map((r, k) => {
            const lastRow = k === rows.length - 1;
            if (r.t === 'fold') {
              const done = r.side === 'done';
              return (
                <li key={`f${r.side}`} class="fc-step">
                  <div class="fc-rail">
                    <Ellipsis done={done} />
                    {lastRow ? null : <div class={done ? 'fc-ln fc-ln-ok' : 'fc-ln'} />}
                  </div>
                  <div class="fc-st">
                    <button type="button" class="fc-more" aria-expanded="false" onClick={() => setOpen({ ...open, [r.side]: true })}>
                      {`${r.count} more ${done ? 'done' : 'queued'}`}
                      <Chevron />
                    </button>
                  </div>
                </li>
              );
            }
            const s = plan[r.i]!;
            const isCur = r.i === cur;
            const done = s.status === 'done';
            return (
              <li key={r.i} class={`fc-step${isCur ? ' fc-step-cur' : ''}`} aria-current={isCur ? 'step' : undefined}>
                <div class="fc-rail">
                  {done ? <DoneDot /> : isCur ? <Now /> : <QueuedDot />}
                  {lastRow ? null : <div class={done ? 'fc-ln fc-ln-ok' : 'fc-ln'} />}
                </div>
                {isCur ? (
                  <div class="fc-st">
                    <div class="fc-curbox">
                      <div class="fc-strong">{s.title}</div>
                      <div class="fc-live">{p.live || 'Working on it…'}</div>
                    </div>
                  </div>
                ) : (
                  <div class={done ? 'fc-st fc-st-done' : 'fc-st fc-st-queued'}>{s.title}</div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}

/** While the task waits on the user: the plan (or sections) as a compact list, paused at the current step. */
export function PausedSteps({ payload: p }: { payload: TaskPayload }) {
  if (p.plan.length) {
    const cur = currentIndex(p.plan);
    return (
      <div class="fc-paused">
        <Meter plan={p.plan} note="paused" right="Clock stops while it waits" />
        <ol class="fc-mini" aria-label="Plan">
          {p.plan.map((s, i) =>
            s.status === 'done' ? (
              <li key={i} class="fc-mini-done"><DoneDot size={16} />{s.title}</li>
            ) : i === cur ? (
              <li key={i} class="fc-mini-cur"><PausedDot />{s.title}</li>
            ) : (
              <li key={i} class="fc-mini-queued"><QueuedDot size={16} />{s.title}</li>
            ),
          )}
        </ol>
      </div>
    );
  }
  if (!p.sections.length) return null;
  return (
    <ol class="fc-mini" aria-label="Progress">
      {p.sections.map((s) =>
        s.done ? (
          <li key={s.id} class="fc-mini-done"><DoneDot size={16} />{s.title}</li>
        ) : (
          <li key={s.id} class="fc-mini-cur"><PausedDot />{s.title}</li>
        ),
      )}
    </ol>
  );
}
