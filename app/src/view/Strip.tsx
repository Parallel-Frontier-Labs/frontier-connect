/** The finished card's "Your tasks" band (spec 2026-11-07 §3): the owner's task counts as links
 * into the task list, each over its own window, and View all. Shown only with server counts and
 * a host that forwards the card's tool calls. */
export interface StripApi {
  /** Open the user's task list over the last `days` days. */
  open(days: number): void;
}

export function ListIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="var(--faint-ink)" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
      <path d="M5.5 3.5h6M5.5 7h6M5.5 10.5h6" />
      <circle cx="2.6" cy="3.5" r="0.7" fill="var(--faint-ink)" stroke="none" />
      <circle cx="2.6" cy="7" r="0.7" fill="var(--faint-ink)" stroke="none" />
      <circle cx="2.6" cy="10.5" r="0.7" fill="var(--faint-ink)" stroke="none" />
    </svg>
  );
}

export function Strip({ stats, api }: { stats: { d7: number; d30: number }; api: StripApi }) {
  return (
    <nav class="fc-strip" aria-label="Your tasks">
      <span class="fc-strip-cap"><ListIcon />Your tasks</span>
      <button type="button" class="fc-strip-link" onClick={() => api.open(7)}>{`${stats.d7} in the last 7 days`}</button>
      <span class="fc-dot" aria-hidden="true">·</span>
      <button type="button" class="fc-strip-link" onClick={() => api.open(30)}>{`${stats.d30} in the last 30 days`}</button>
      <span class="fc-strip-gap" />
      <button type="button" class="fc-strip-link" onClick={() => api.open(30)}>View all →</button>
    </nav>
  );
}
