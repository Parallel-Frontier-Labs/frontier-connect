import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DeleteOutcome, Stale } from '../bridge';
import { formatWork } from '../format';
import {
  DAYS, LIST_STATUS_LABEL, LIST_STATUSES, QUERY_MAX, SOURCE_LABEL, SOURCES,
  type ListItem, type ListPayload, type ListStatus, type Source,
} from '../list';
import { Chevron, Mark } from './icons';
import {
  DAYS_LABEL, DeletedPill, FilterSelect, formatStart, SourceChip, StatusPill, TrashIcon, type ListActions,
} from './TaskList';

/** How long typing pauses before the title search is sent. */
export const SEARCH_DEBOUNCE_MS = 300;
export const STOP_FIRST_NOTE = 'This task is still running. Stop it first, then delete it.';
const LIVE: ReadonlySet<ListStatus> = new Set(['running', 'waiting']);

export interface FullViewProps {
  list: ListPayload;
  theme?: 'light' | 'dark';
  actions: ListActions;
  /** The task open in the pane (null: none yet). */
  selected: string | null;
  onSelect(taskId: string | null): void;
  /** The pane's task card, rendered by Root (it owns polling, downloads and previews). */
  pane: JSX.Element | null;
  /** The selected task is still loading, or failed to open. */
  paneNote: string | null;
  /** True while the selected task runs or waits: Delete explains instead of acting. */
  live: boolean;
  /** Stop the selected task; true when the server accepted it. */
  onStop?: () => Promise<boolean>;
  onExit(): void;
}

const DELETE_COPY = "This removes the task and its files. Its usage stays in Observe. This can't be undone.";

/** A row's own delete confirm (the bin), shown inside the row like the inline list's. */
function RowConfirm({ item, busy, error, onCancel, onConfirm }: {
  item: ListItem; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <li class="fc-frow fc-row-confirm fc-frow-confirm" data-task={item.task_id}>
      <div class="fc-confirm" role="alertdialog" aria-labelledby={`fdel-h-${item.task_id}`} aria-describedby={`fdel-d-${item.task_id}`}>
        <div id={`fdel-h-${item.task_id}`} class="fc-confirm-h">{`Delete "${item.title}"?`}</div>
        <div id={`fdel-d-${item.task_id}`} class="fc-confirm-d">{DELETE_COPY}</div>
        <div class="fc-confirm-b">
          <button type="button" class="fc-secondary fc-secondary-sm" ref={cancelRef} disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" class="fc-danger" disabled={busy} onClick={onConfirm}>{busy ? 'Deleting…' : 'Delete'}</button>
        </div>
        {error ? <p class="fc-err" role="alert">{error}</p> : null}
      </div>
    </li>
  );
}

function SideRow({ item, selected, onSelect, onBin, note }: {
  item: ListItem; selected: boolean; onSelect: () => void; onBin: () => void; note: string | null;
}) {
  if (item.deleted) {
    return (
      <li class="fc-frow fc-row-deleted" data-task={item.task_id}>
        <div class="fc-frow-main">
          <span class="fc-rt fc-rt-plain">{item.title}</span>
          <span class="fc-rm fc-mono">
            <span>{formatStart(item.started_at)}</span>
            <span class="fc-dot" aria-hidden="true">·</span>
            <SourceChip source={item.source} />
          </span>
        </div>
        <DeletedPill />
      </li>
    );
  }
  const live = LIVE.has(item.status);
  return (
    <li class={selected ? 'fc-frow fc-frow-on' : 'fc-frow'} data-task={item.task_id}>
      <button type="button" class="fc-frow-open" aria-current={selected ? 'true' : undefined} onClick={onSelect}>
        <span class="fc-frow-main">
          <span class="fc-rt">{item.title}</span>
          <span class="fc-rm fc-mono">
            <span>{formatStart(item.started_at)}</span>
            <span class="fc-dot" aria-hidden="true">·</span>
            <SourceChip source={item.source} />
            <span class="fc-dot" aria-hidden="true">·</span>
            <span>{live ? `${formatWork(item.work_ms)} so far` : formatWork(item.work_ms)}</span>
          </span>
        </span>
        <StatusPill status={item.status} />
      </button>
      <button type="button" class={live ? 'fc-bin fc-bin-off' : 'fc-bin'} onClick={onBin}
        aria-label={`Delete ${item.title}`} title={live ? 'Stop the task first' : 'Delete task'}>
        <TrashIcon />
      </button>
      {note ? <p class="fc-muted fc-row-note fc-frow-note" role="status">{note}</p> : null}
    </li>
  );
}

/** "Your Frontier tasks" in full screen (spec 2026-11-07 §1): search, filters and rows on the
 * left, the selected task's results on the right with Stop and Delete. No chat inputs. */
export function FullView({
  list, theme = 'light', actions, selected, onSelect, pane, paneNote, live, onStop, onExit,
}: FullViewProps) {
  const f = list.filters;
  const [q, setQ] = useState(f.query ?? '');
  const [loading, setLoading] = useState<'filter' | 'more' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Keyed by task: a confirm or note asked for one task never shows on another.
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [liveNoteFor, setLiveNoteFor] = useState<string | null>(null);
  // The row bin confirms inside its own row (spec feedback 2026-11-07), apart from the pane's Delete.
  const [rowConfirm, setRowConfirm] = useState<string | null>(null);
  const [rowNote, setRowNote] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paneError, setPaneError] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The selection NOW, for a delete that settles after the user picked another task.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const searched = useRef(f.query ?? '');

  const run = async (change: { days?: number; status?: ListStatus | null; source?: Source | null; query?: string | null; cursor?: string | null }, append: boolean) => {
    setLoading(append ? 'more' : 'filter');
    setError(null);
    const query = change.query !== undefined ? change.query : f.query;
    const err = await actions.query({
      days: change.days ?? f.days,
      status: change.status !== undefined ? change.status : f.status,
      source: change.source !== undefined ? change.source : f.source,
      ...(query ? { query } : {}),
      ...(change.cursor ? { cursor: change.cursor } : {}),
    }, append);
    setLoading(null);
    if (err) setError(err);
  };

  // Typing waits SEARCH_DEBOUNCE_MS, then searches; Root's query guard drops a superseded answer.
  const onType = (value: string) => {
    const v = value.slice(0, QUERY_MAX);
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const query = v.trim();
      if (query === searched.current) return;
      searched.current = query;
      void run({ query: query || null }, false);
    }, SEARCH_DEBOUNCE_MS);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const confirm = !!selected && confirmFor === selected;
  const liveNote = !!selected && liveNoteFor === selected;
  // A new selection drops an error shown for the previous one.
  useEffect(() => setPaneError(null), [selected]);

  const ask = (taskId: string, itemLive: boolean) => {
    if (taskId !== selected) onSelect(taskId);
    setSaid('');
    // The row's state is the list's snapshot; the pane's `live` is the fresh one for the open task.
    if (itemLive || (taskId === selected && live)) {
      setConfirmFor(null);
      setLiveNoteFor(taskId);
      return;
    }
    setLiveNoteFor(null);
    setConfirmFor(taskId);
  };
  const selItem = list.items.find((i) => i.task_id === selected) ?? null;
  /** Delete `id` (from the pane, or from its row's own confirm). A deleted open task hands the
   * pane to the next row. */
  const remove = async (id: string, fromRow: boolean) => {
    if (busy) return;
    const title = list.items.find((i) => i.task_id === id)?.title ?? 'the task';
    setBusy(true);
    setPaneError(null);
    setRowError(null);
    const out: DeleteOutcome | Stale = await actions.remove(id);
    setBusy(false);
    if (out.kind === 'stale') return;
    if (out.kind === 'deleted') {
      setConfirmFor(null);
      setRowConfirm(null);
      setSaid(`Deleted “${title}”.`);
      if (id === selectedRef.current) {
        const rest = list.items.filter((i) => i.task_id !== id && !i.deleted);
        const at = Math.max(0, list.items.findIndex((i) => i.task_id === id));
        const next = rest[Math.min(at, rest.length - 1)] ?? null;
        onSelect(next ? next.task_id : null);
      }
      return;
    }
    const msg = out.kind === 'refused' ? out.reason : out.message;
    if (fromRow) setRowError(msg);
    else setPaneError(msg);
  };
  const doDelete = () => (selected ? remove(selected, false) : undefined);
  const bin = (it: ListItem) => {
    setSaid('');
    setRowError(null);
    if (LIVE.has(it.status) || (it.task_id === selected && live)) {
      setRowConfirm(null);
      setRowNote(it.task_id);
      return;
    }
    setRowNote(null);
    setRowConfirm(it.task_id);
  };

  const dayChoices = (DAYS as readonly number[]).includes(f.days) ? [...DAYS] : [...DAYS, f.days].sort((a, b) => a - b);
  const cap = f.query ? `${list.total === 1 ? '1 match' : `${list.total} matches`} · newest first` : 'Newest first';
  const empty = f.query
    ? `No task titles match “${f.query}” in the ${DAYS_LABEL(f.days).toLowerCase()}. Try a longer time range.`
    : `No tasks in the ${DAYS_LABEL(f.days).toLowerCase()}.`;

  return (
    <div class="fc-full" data-theme={theme}>
      <header class="fc-full-head">
        <Mark />
        <div class="fc-heading">
          <div class="fc-title">Your Frontier tasks</div>
          <div class="fc-org">{[list.org, `${list.total} ${list.total === 1 ? 'task' : 'tasks'} in the ${DAYS_LABEL(f.days).toLowerCase()}`].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="fc-fchips" role="group" aria-label="Filters">
          <FilterSelect label="Dates" value={f.days} disabled={!!loading}
            options={dayChoices.map((d) => ({ value: d as number, label: DAYS_LABEL(d) }))}
            onChange={(v) => void run({ days: v ?? 7 }, false)} />
          <FilterSelect label="Status" value={f.status} disabled={!!loading}
            options={[{ value: null, label: 'All statuses' }, ...LIST_STATUSES.map((s) => ({ value: s, label: LIST_STATUS_LABEL[s] }))]}
            onChange={(v) => void run({ status: v }, false)} />
          <FilterSelect label="App" value={f.source} disabled={!!loading}
            options={[{ value: null, label: 'All apps' }, ...SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))]}
            onChange={(v) => void run({ source: v }, false)} />
        </div>
        <button type="button" class="fc-secondary fc-secondary-sm fc-exit" onClick={onExit}>Exit full screen</button>
      </header>
      <div class="fc-full-body">
        <nav class="fc-full-list" aria-label="Tasks">
          <div class="fc-search">
            <label class="fc-sr" for="fc-q">Search task titles</label>
            <svg class="fc-search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />
            </svg>
            <input id="fc-q" type="search" class="fc-search-input" placeholder="Search task titles" value={q}
              maxLength={QUERY_MAX} onInput={(e) => onType((e.target as HTMLInputElement).value)} />
          </div>
          <div class="fc-cap fc-full-cap">{cap}</div>
          {error ? <p class="fc-err fc-list-err" role="alert">{error}</p> : null}
          {list.items.length ? (
            <ul class={loading === 'filter' ? 'fc-frows fc-rows-busy' : 'fc-frows'} aria-busy={loading === 'filter' || undefined}>
              {list.items.map((it) => rowConfirm === it.task_id && !it.deleted ? (
                <RowConfirm key={it.task_id} item={it} busy={busy} error={rowError}
                  onCancel={() => { setRowConfirm(null); setRowError(null); }}
                  onConfirm={() => void remove(it.task_id, true)} />
              ) : (
                <SideRow key={it.task_id} item={it} selected={it.task_id === selected}
                  note={rowNote === it.task_id ? 'Stop it first, then delete it.' : null}
                  onSelect={() => onSelect(it.task_id)} onBin={() => bin(it)} />
              ))}
            </ul>
          ) : <p class="fc-empty">{empty}</p>}
          {list.next_cursor && !list.capped ? (
            <button type="button" class="fc-toggle fc-full-more" disabled={!!loading} onClick={() => void run({ cursor: list.next_cursor }, true)}>
              {loading === 'more' ? 'Loading…' : 'Show more'}
              {loading === 'more' ? null : <Chevron />}
            </button>
          ) : null}
        </nav>
        <main class="fc-full-pane">
          {selected ? (
            <div class="fc-pane-bar">
              <span class="fc-cap">Task</span>
              <span class="fc-strip-gap" />
              {live && onStop ? (
                <button type="button" class="fc-secondary fc-secondary-sm" onClick={() => void onStop()}>Stop task</button>
              ) : null}
              <button type="button" class={live ? 'fc-pane-del fc-pane-del-off' : 'fc-pane-del'} aria-disabled={live ? 'true' : undefined}
                title={live ? 'Stop the task first' : 'Delete this task and its files'}
                onClick={() => selected && ask(selected, false)}>
                <TrashIcon />
                Delete task
              </button>
            </div>
          ) : null}
          {confirm && selected ? (
            <div class="fc-pane-confirm" role="alertdialog" aria-labelledby="fc-del-h" aria-describedby="fc-del-d">
              <div class="fc-pane-confirm-text">
                <div id="fc-del-h" class="fc-confirm-h">{`Delete "${selItem?.title ?? 'this task'}"?`}</div>
                <div id="fc-del-d" class="fc-confirm-d">{DELETE_COPY}</div>
              </div>
              <div class="fc-confirm-b">
                <button type="button" class="fc-secondary fc-secondary-sm" disabled={busy} onClick={() => setConfirmFor(null)}>Cancel</button>
                <button type="button" class="fc-danger" disabled={busy} onClick={() => void doDelete()}>{busy ? 'Deleting…' : 'Delete'}</button>
              </div>
            </div>
          ) : null}
          {liveNote && selected ? <p class="fc-pane-note" role="status">{STOP_FIRST_NOTE}</p> : null}
          {paneError ? <p class="fc-err fc-pane-note" role="alert">{paneError}</p> : null}
          {said ? <p class="fc-pane-note fc-pane-ok" role="status">{said}</p> : null}
          {selected ? (pane ?? <p class="fc-pane-note fc-muted" role="status">{paneNote ?? 'Opening…'}</p>) : (
            <div class="fc-pane-empty">
              <span class="fc-strong">Select a task</span>
              <span class="fc-muted">Its results open here.</span>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
