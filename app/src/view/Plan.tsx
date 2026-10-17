import type { PlanStep } from '../types';

const LABEL = new Map<PlanStep['status'], string>([
  ['queued', 'Queued'],
  ['in_progress', 'In progress'],
  ['done', 'Done'],
]);

export function Plan({ plan }: { plan: PlanStep[] }) {
  if (!plan.length) return null;
  return (
    <section class="fc-plan" aria-label="Plan">
      <h3 class="fc-h">Plan</h3>
      <ul>
        {plan.map((p, i) => (
          <li key={i} class={`fc-plan-${p.status}`}>
            <span>{p.title}</span>
            <span class="fc-muted">{LABEL.get(p.status) ?? 'Queued'}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
