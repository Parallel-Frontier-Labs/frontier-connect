import type { Section } from '../types';

export function Sections({ sections, live, active }: { sections: Section[]; live: string | null; active: boolean }) {
  const current = active ? sections.findIndex((s) => !s.done) : -1;
  return (
    <ol class="fc-steps">
      {sections.map((s, i) => (
        <li key={s.id} class={s.done ? 'fc-step fc-done' : i === current ? 'fc-step fc-current' : 'fc-step'}>
          <span class={`fc-mark ${s.done ? 'fc-mark-done' : i === current ? 'fc-mark-live' : ''}`} aria-hidden="true" />
          <span class="fc-step-body">
            <span class="fc-step-title">{s.title}</span>
            {s.done && s.outcome ? <span class="fc-muted"> · {s.outcome}</span> : null}
            {i === current && live ? <span class="fc-live">{live}</span> : null}
          </span>
        </li>
      ))}
      {active && current === -1 && live ? <li class="fc-live-only">{live}</li> : null}
    </ol>
  );
}
