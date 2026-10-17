import { formatEta } from '../format';
import type { Status, TaskPayload } from '../types';
import { Ask } from './Ask';
import { Done, Files } from './Done';
import { Plan } from './Plan';
import { Sections } from './Sections';

const PILL = new Map<Status, string>([
  ['starting', 'Starting'],
  ['running', 'Working'],
  ['waiting_for_answer', 'Waiting for your answer'],
  ['waiting_for_you', 'Waiting for you'],
  ['done', 'Done'],
  ['stopped', 'Stopped'],
  ['error', 'Stopped with an error'],
]);

export function Card({ payload: p, theme = 'light' }: { payload: TaskPayload; theme?: 'light' | 'dark' }) {
  const active = p.status === 'running' || p.status === 'starting';
  const eta = p.status === 'running' && p.estimate ? formatEta(p.estimate.eta_s) : null;
  const empty = !p.sections.length && !p.plan.length;
  return (
    <article class="fc-card" data-theme={theme} aria-label="Frontier task">
      <header class="fc-head">
        <div class="fc-title">{p.title || 'Frontier task'}</div>
        <span class={`fc-pill fc-pill-${p.status}`}>{PILL.get(p.status) ?? 'Starting'}</span>
      </header>
      <div class="fc-body">
        {eta ? <div class="fc-eta">{eta}</div> : null}
        {p.sections.length ? <Sections sections={p.sections} live={p.live} active={active} /> : null}
        {!p.sections.length && active && p.live ? <p class="fc-live-only">{p.live}</p> : null}
        <Plan plan={p.plan} />
        {empty && active && !p.live ? <p class="fc-muted">Getting started…</p> : null}
        {p.open_ask ? <Ask ask={p.open_ask} /> : null}
        {p.status === 'done' ? <Done payload={p} /> : null}
        {p.status === 'error' || p.status === 'stopped' ? (
          p.result?.summary ? <p class="fc-summary">{p.result.summary}</p> : null
        ) : null}
        <Files files={p.deliverables} />
      </div>
    </article>
  );
}
