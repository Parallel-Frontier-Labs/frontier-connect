import { cardClass } from '../format';
import { Mark } from './icons';
import { Strip, type StripApi } from './Strip';

export const DELETED_HEAD = 'This task was deleted';
export const DELETED_BODY = 'Its results and files have been removed.';

/** A task card whose task was deleted (spec 2026-11-07 §4): the title kept so the chat still
 * reads, a plain label (never a pill or icon that looks like a button), the note, and the strip. */
export function DeletedCard({
  title, org, theme = 'light', embedded = true, stats, strip,
}: {
  title: string; org?: string | null; theme?: 'light' | 'dark'; embedded?: boolean;
  stats?: { d7: number; d30: number } | null; strip?: StripApi;
}) {
  return (
    <article class={`${cardClass(embedded)} fc-card-deleted`} data-theme={theme} aria-label={`Frontier task: ${title || 'Frontier task'}, deleted`}>
      <header class="fc-head">
        <Mark />
        <div class="fc-heading">
          <div class="fc-title fc-title-muted">{title || 'Frontier task'}</div>
          <div class="fc-org">{org || 'Frontier'}</div>
        </div>
        <span class="fc-cap fc-deleted-label">Deleted</span>
      </header>
      <div class="fc-body">
        <div class="fc-gone" role="status">
          <span class="fc-gone-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3.5 6h13M8 6V4h4v2M5 6l.8 10.2a1 1 0 0 0 1 .8h6.4a1 1 0 0 0 1-.8L15 6M8.5 9v5M11.5 9v5" />
            </svg>
          </span>
          <span class="fc-gone-text">
            <span class="fc-gone-head">{DELETED_HEAD}</span>
            <span class="fc-gone-body">{DELETED_BODY}</span>
          </span>
        </div>
      </div>
      {stats && strip ? <Strip stats={stats} api={strip} /> : null}
    </article>
  );
}
