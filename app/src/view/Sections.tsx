import { formatEta } from '../format';
import type { TaskEvent, TaskPayload } from '../types';
import { DoneDot, Now } from './icons';

/** The latest narration / activity lines, newest first. */
export function latestActivity(events: TaskEvent[], n = 3): string[] {
  const out: string[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < n; i--) {
    const e = events[i]!;
    if ((e.kind === 'narration' || e.kind === 'activity') && e.text.trim()) out.push(e.text.trim());
  }
  return out;
}

/** Running without a plan: what it is doing now, what is done so far, and the latest activity. */
export function NoPlan({ payload: p }: { payload: TaskPayload }) {
  const starting = p.status === 'starting';
  const current = [...p.sections].reverse().find((s) => !s.done);
  const done = p.sections.filter((s) => s.done);
  const title = current?.title || (starting ? 'Getting started' : 'Working');
  const sub = p.live || (starting ? 'Setting up the task…' : null);
  const eta = p.status === 'running' && p.estimate ? formatEta(p.estimate.eta_s) : null;
  const activity = latestActivity(p.events);
  return (
    <div class="fc-body">
      <section class="fc-nowbox" aria-label="Now">
        <div class="fc-nowrow">
          <Now />
          <div class="fc-nowtext">
            <div class="fc-nowtitle">{title}</div>
            {sub ? <div class="fc-live">{sub}</div> : null}
          </div>
          {eta ? <div class="fc-mono fc-meter-eta fc-nowrap">{eta}</div> : null}
        </div>
        <div class="fc-track" aria-hidden="true"><div class="fc-runner" /></div>
      </section>
      {done.length ? (
        <section class="fc-group" aria-label="Done so far">
          <h3 class="fc-cap">Done so far</h3>
          <ul class="fc-donelist">
            {done.map((s) => (
              <li key={s.id}>
                <DoneDot size={16} />
                <span>
                  {s.title}
                  {s.outcome ? <span class="fc-muted"> · {s.outcome}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {activity.length ? (
        <>
          {done.length ? <div class="fc-rule" /> : null}
          <section class="fc-group" aria-label="Latest activity">
            <h3 class="fc-cap">Latest activity</h3>
            <ol class="fc-events">
              {activity.map((t, i) => (
                <li key={i} class={i === 0 ? 'fc-ev fc-ev-new' : 'fc-ev'}>
                  <span class="fc-ev-mark" aria-hidden="true">›</span>
                  <span>{t}</span>
                </li>
              ))}
            </ol>
          </section>
        </>
      ) : null}
    </div>
  );
}
