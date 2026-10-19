import { useEffect, useRef, useState } from 'preact/hooks';
import type { DeleteOutcome, ListQuery, Stale } from '../bridge';
import { formatWork } from '../format';
import {
  DAYS, isLive, LIST_CAP, LIST_STATUS_LABEL, LIST_STATUSES, SOURCE_LABEL, SOURCES,
  type ListItem, type ListPayload, type ListStatus, type Source,
} from '../list';
import { Chevron, Mark } from './icons';

/** The tinted source name chip (Frontier blue, Claude orange, ChatGPT/Codex grey, Scheduled violet). */
export function SourceChip({ source }: { source: Source }) {
  return <span class={`fc-src fc-src-${source}`}>{SOURCE_LABEL[source]}</span>;
}

const DAYS_LABEL = (d: number) => (d === 1 ? 'Last 24 hours' : `Last ${d} days`);

/** "Oct 18 · 09:42" in the viewer's time zone. */
export function formatStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} · ${time}`;
}

const STATUS_DOT: Partial<Record<ListStatus, true>> = { running: true, waiting: true };

function StatusPill({ status }: { status: ListStatus }) {
  return (
    <span class={`fc-pill fc-pill-sm fc-lpill-${status}`}>
      {STATUS_DOT[status] ? <span class="fc-pd" aria-hidden="true" /> : null}
      {LIST_STATUS_LABEL[status]}
    </span>
  );
}

function Dots() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
      <path d="M2.5 4h9M5.5 4V2.5h3V4M3.5 4l.6 7.5h5.8l.6-7.5" />
    </svg>
  );
}

export interface ListActions {
  /** The host forwards the card's tool calls: filters, Show more, open and delete work. */
  enabled: boolean;
  query(q: ListQuery, append: boolean): Promise<string | null>;
  open(taskId: string): Promise<string | null>;
  remove(taskId: string): Promise<DeleteOutcome | Stale>;
}

function Row({
  item, actions, menuOpen, setMenu, confirming, setConfirm, onDeleted,
}: {
  item: ListItem; actions: ListActions; menuOpen: boolean; setMenu: (id: string | null) => void;
  confirming: boolean; setConfirm: (id: string | null) => void; onDeleted: (item: ListItem) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const menuRef = useRef<HTMLUListElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const live = isLive(item.status);
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [menuOpen]);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);
  const open = async () => {
    if (!actions.enabled || opening) return;
    setMenu(null);
    setOpening(true);
    setError(null);
    const err = await actions.open(item.task_id);
    setOpening(false);
    if (err) setError(err);
  };
  const confirmDelete = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const out = await actions.remove(item.task_id);
    // The card moved on meanwhile: show nothing (a deletion that landed is still filtered out).
    if (out.kind === 'stale') {
      setBusy(false);
      return;
    }
    if (out.kind === 'deleted') {
      onDeleted(item);
      return;
    }
    setBusy(false);
    setError(out.kind === 'refused' ? out.reason : out.message);
  };
  const meta = (
    <div class="fc-rm fc-mono">
      <span>{formatStart(item.started_at)}</span>
      <span class="fc-dot" aria-hidden="true">·</span>
      <SourceChip source={item.source} />
      <span class="fc-dot" aria-hidden="true">·</span>
      <span>{live ? `${formatWork(item.work_ms)} so far` : formatWork(item.work_ms)}</span>
      {item.turn > 1 ? (
        <>
          <span class="fc-dot" aria-hidden="true">·</span>
          <span>{`turn ${item.turn}`}</span>
        </>
      ) : null}
    </div>
  );
  if (confirming) {
    return (
      <li class="fc-row fc-row-confirm">
        <div class="fc-row-top">
          <div class="fc-rmain">
            <span class="fc-rt fc-rt-plain">{item.title}</span>
            {meta}
          </div>
          <StatusPill status={item.status} />
        </div>
        <div class="fc-confirm" role="alertdialog" aria-labelledby={`del-h-${item.task_id}`} aria-describedby={`del-d-${item.task_id}`}>
          <div id={`del-h-${item.task_id}`} class="fc-confirm-h">{`Delete "${item.title}"?`}</div>
          <div id={`del-d-${item.task_id}`} class="fc-confirm-d">This removes the task and its files. Its usage stays in Observe. This can't be undone.</div>
          <div class="fc-confirm-b">
            <button type="button" class="fc-danger" disabled={busy} onClick={() => void confirmDelete()}>
              {busy ? 'Deleting…' : 'Delete'}
            </button>
            <button type="button" class="fc-secondary fc-secondary-sm" ref={cancelRef} disabled={busy}
              onClick={() => { setConfirm(null); setError(null); moreRef.current?.focus(); }}>
              Cancel
            </button>
          </div>
          {error ? <p class="fc-err" role="alert">{error}</p> : null}
        </div>
      </li>
    );
  }
  return (
    <li class="fc-row" data-task={item.task_id}>
      <div class="fc-row-top">
        <div class="fc-rmain">
          {actions.enabled ? (
            <button type="button" class="fc-rt" aria-busy={opening || undefined} onClick={() => void open()}>{item.title}</button>
          ) : (
            <span class="fc-rt fc-rt-plain">{item.title}</span>
          )}
          {meta}
        </div>
        <StatusPill status={item.status} />
        {actions.enabled ? (
          <button type="button" class={menuOpen ? 'fc-moreb fc-moreb-on' : 'fc-moreb'} ref={moreRef}
            aria-label={`More actions for ${item.title}`} aria-haspopup="menu" aria-expanded={menuOpen}
            onClick={() => setMenu(menuOpen ? null : item.task_id)}>
            <Dots />
          </button>
        ) : null}
      </div>
      {menuOpen ? (
        <ul class="fc-menu" role="menu" aria-label={`${item.title} actions`} ref={menuRef}
          onKeyDown={(e) => { if (e.key === 'Escape') { setMenu(null); moreRef.current?.focus(); } }}>
          <li role="none">
            <button type="button" class="fc-mi" role="menuitem" onClick={() => void open()}>Open</button>
          </li>
          <li role="none">
            <button type="button" class="fc-mi" role="menuitem" disabled={live}
              aria-describedby={live ? `stop-${item.task_id}` : undefined}
              onClick={() => { setMenu(null); setConfirm(item.task_id); }}>
              <TrashIcon />
              <span class="fc-mi-l">Delete</span>
              {live ? <span id={`stop-${item.task_id}`} class="fc-mi-note">Stop it first</span> : null}
            </button>
          </li>
        </ul>
      ) : null}
      {opening ? <p class="fc-muted fc-row-note" role="status">Opening…</p> : null}
      {error ? <p class="fc-err fc-row-note" role="alert">{error}</p> : null}
    </li>
  );
}

function FilterSelect<T extends string | number>({
  label, value, options, onChange, disabled,
}: {
  label: string; value: T | null; options: { value: T | null; label: string }[]; onChange: (v: T | null) => void; disabled: boolean;
}) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <label class="fc-fchip">
      <span class="fc-sr">{label}</span>
      <select disabled={disabled} value={String(idx)} onChange={(e) => onChange(options[Number((e.target as HTMLSelectElement).value)]!.value)}>
        {options.map((o, i) => <option key={i} value={String(i)}>{o.label}</option>)}
      </select>
      <Chevron size={11} />
    </label>
  );
}

/** "Your Frontier tasks": filters, rows with an inline delete confirm, Show more. */
export function TaskList({
  list, theme = 'light', actions, announce,
}: {
  list: ListPayload; theme?: 'light' | 'dark'; actions: ListActions; announce?: string;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [loading, setLoading] = useState<'filter' | 'more' | null>(null);
  const [moreFailed, setMoreFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string>('');
  const headRef = useRef<HTMLDivElement>(null);
  const f = list.filters;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('.fc-menu, .fc-moreb')) setMenu(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const run = async (q: ListQuery, append: boolean) => {
    if (loading) return;
    setLoading(append ? 'more' : 'filter');
    setError(null);
    setMenu(null);
    setConfirm(null);
    if (append) setMoreFailed(false);
    const err = await actions.query(q, append);
    setLoading(null);
    // A failed page (Show more, or the refill after deleting the visible rows) offers a retry with
    // the same cursor; a failed filter change shows its message.
    if (err && append) setMoreFailed(true);
    else if (err) setError(err);
  };
  const more = () => void run({ days: f.days, status: f.status, source: f.source, cursor: list.next_cursor }, true);
  const refilter = (change: Partial<ListQuery>) =>
    void run({ days: f.days, status: f.status, source: f.source, ...change }, false);

  const summary = [DAYS_LABEL(f.days), f.status ? LIST_STATUS_LABEL[f.status] : null, f.source ? SOURCE_LABEL[f.source] : null, list.org]
    .filter(Boolean)
    .join(' · ');
  const filtered = !!(f.status || f.source);
  // A range the model chose that is not a preset (say 14 days) is offered as itself, not snapped.
  const dayChoices = (DAYS as readonly number[]).includes(f.days) ? [...DAYS] : [...DAYS, f.days].sort((a, b) => a - b);

  // Deleting every visible row must not strand the rest: load the next page by itself.
  useEffect(() => {
    if (actions.enabled && !list.items.length && list.next_cursor && !loading && !list.capped) {
      void run({ days: f.days, status: f.status, source: f.source, cursor: list.next_cursor }, true);
    }
  }, [list.items.length, list.next_cursor]);
  const live = said || announce || `${list.items.length} of ${list.total} tasks shown.`;

  return (
    <article class="fc-card" data-theme={theme} aria-label="Your Frontier tasks">
      <header class="fc-head fc-head-list">
        <Mark />
        <div class="fc-heading" ref={headRef} tabIndex={-1}>
          <div class="fc-title">Your Frontier tasks</div>
          <div class="fc-org">{summary}</div>
        </div>
      </header>
      {actions.enabled ? (
        <div class="fc-fchips" role="group" aria-label="Filters">
          <FilterSelect label="Dates" value={f.days} disabled={!!loading}
            options={dayChoices.map((d) => ({ value: d as number, label: DAYS_LABEL(d) }))}
            onChange={(v) => refilter({ days: v ?? 7 })} />
          <FilterSelect label="Status" value={f.status} disabled={!!loading}
            options={[{ value: null, label: 'All statuses' }, ...LIST_STATUSES.map((s) => ({ value: s, label: LIST_STATUS_LABEL[s] }))]}
            onChange={(v) => refilter({ status: v })} />
          <FilterSelect label="App" value={f.source} disabled={!!loading}
            options={[{ value: null, label: 'All apps' }, ...SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))]}
            onChange={(v) => refilter({ source: v })} />
        </div>
      ) : null}
      {list.items.length ? (
        <ul class={loading === 'filter' ? 'fc-rows fc-rows-busy' : 'fc-rows'} aria-label="Tasks, newest first" aria-busy={loading === 'filter' || undefined}>
          {list.items.map((it) => (
            <Row key={it.task_id} item={it} actions={actions} menuOpen={menu === it.task_id} setMenu={setMenu}
              confirming={confirm === it.task_id} setConfirm={setConfirm}
              onDeleted={(item) => {
                setConfirm(null);
                setSaid(`Deleted "${item.title}".`);
                headRef.current?.focus();
              }} />
          ))}
        </ul>
      ) : (
        <p class="fc-empty">
          {filtered ? `No tasks match these filters in the ${DAYS_LABEL(f.days).toLowerCase()}.` : `No tasks in the ${DAYS_LABEL(f.days).toLowerCase()}.`}
        </p>
      )}
      {error ? <p class="fc-err fc-list-err" role="alert">{error}</p> : null}
      {list.items.length || !actions.enabled || (list.next_cursor && !list.capped) ? (
        <div class="fc-lfoot">
          {list.capped ? (
            <span class="fc-muted fc-capped">{`Showing ${Math.min(list.shown, LIST_CAP)} of ${list.total}. Narrow the dates or filters to see more.`}</span>
          ) : actions.enabled && list.next_cursor && moreFailed && !loading ? (
            <span class="fc-more-failed" role="alert">
              <span class="fc-err">Couldn't load more.</span>
              <button type="button" class="fc-toggle" onClick={more}>Retry</button>
            </span>
          ) : actions.enabled && list.next_cursor ? (
            <button type="button" class="fc-toggle" disabled={!!loading} onClick={more}>
              {loading === 'more' ? 'Loading…' : 'Show more'}
              {loading === 'more' ? null : <Chevron />}
            </button>
          ) : !actions.enabled ? (
            <span class="fc-muted">Ask in the chat to filter or open a task</span>
          ) : <span />}
          {list.items.length ? <span class="fc-mono fc-count">{`${list.items.length} of ${list.total}`}</span> : null}
        </div>
      ) : null}
      <div class="fc-sr" aria-live="polite" aria-atomic="true">{live}</div>
    </article>
  );
}
