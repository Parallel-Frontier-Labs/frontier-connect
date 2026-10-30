import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AnswerOutcome, Answers, Bridge, DeleteOutcome, DownloadOutcome, ListQuery, Stale } from './bridge';
import { cardClass } from './format';
import { Generations, type Guarded, type Tag } from './generation';
import { createHostBridge, LINK_FAILED, LIST_FAILED } from './hostBridge';
import { appendPage, type ListPayload } from './list';
import { BrowserFeed, postControl, postInput, sendHostReport, type FrameSource } from './browserFeed';
import type { BrowserApi, Transport } from './view/BrowserPreview';
import { Poller } from './poller';
import { Card, type AnswerApi } from './view/Card';
import { AddFiles } from './view/AddFiles';
import { NO_UPLOADS, type UploadApi } from './view/UploadPanel';
import type { AddFilesPayload } from './upload/addFiles';
import { sendFiles } from './upload/transfer';
import type { DownloadApi } from './view/Files';
import { TaskList, type ListActions } from './view/TaskList';
import type { TaskPayload } from './types';
import { NO_PREVIEW, type PreviewGate } from './view/PreviewPane';
import { fetchFileBytes } from './preview/fetchFile';
import { loadViewer, viewersAvailable } from './preview/loader';

/** How long the host gets to open a download link before the card shows the link itself. */
export const OPEN_LINK_WAIT_MS = 5000;

/** `p`, or false once `ms` pass or it rejects. */
function withTimeout(p: Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(false); },
    );
  });
}

export const OPEN_FAILED = "Couldn't open the task. Try again, or ask in the chat.";
export const TASK_DELETED = 'This task was deleted.';
const STALE: Stale = { kind: 'stale' };

/**
 * What the card shows: a task (from a task tool result, or opened from the list), the list of the
 * user's tasks, or a note that the task shown was deleted. The list state (filters, loaded rows,
 * scroll) lives here, so "← All tasks" comes back to exactly where the user was.
 *
 * Every server call goes through `gens.run` (see generation.ts), so a result that arrives after the
 * card moved on is dropped; and every result passes the `deleted` filter, so a task deleted from
 * the card never comes back from a late read.
 */
type Mode = { kind: 'task'; fromList: boolean } | { kind: 'list' } | { kind: 'add' } | { kind: 'deleted'; fromList: boolean };

export function Root({ makeBridge = () => createHostBridge() }: { makeBridge?: () => Bridge }) {
  const [payload, setPayload] = useState<TaskPayload | null>(null);
  const [add, setAdd] = useState<AddFilesPayload | null>(null);
  const [list, setListState] = useState<ListPayload | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'task', fromList: false });
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [embedded, setEmbedded] = useState(true);
  const [connectFailed, setConnectFailed] = useState(false);
  const [canAnswer, setCanAnswer] = useState(false);
  const poller = useRef<Poller | null>(null);
  const bridgeRef = useRef<Bridge | null>(null);
  const taskRef = useRef<string | null>(null);
  const backTo = useRef<{ scrollY: number; taskId: string } | null>(null);
  const gens = useRef(new Generations()).current;
  const deleted = useRef(new Set<string>()).current;
  // The tag the current poll session runs under: poll results from an older view are dropped.
  const pollTag = useRef<Tag>(gens.tag());
  // The task on screen right now (null on the list or the deleted note): answers are tied to it.
  const shownTask = useRef<string | null>(null);
  // Remounts the list view when the host sends a fresh list (resets its menus and spinners).
  const [listEpoch, setListEpoch] = useState(0);
  // Display modes the host offers (the browser preview's Full screen button).
  const [modes, setModes] = useState<readonly string[] | undefined>(undefined);
  const [displayMode, setDisplayMode] = useState('inline');
  // The Poller's transport: false once the host blocks the card's own requests (bridge only).
  const [transport, setTransport] = useState<Transport>('direct');
  // One host report per card mount, once the handshake is done and a view token is known.
  const hostReady = useRef(false);
  const reported = useRef(false);

  /** Rows of deleted tasks never come back, whichever response carries them. */
  const clean = (l: ListPayload): ListPayload => {
    const items = l.items.filter((i) => !deleted.has(i.task_id));
    const gone = l.items.length - items.length;
    return gone ? { ...l, items, total: Math.max(0, l.total - gone), shown: Math.max(0, l.shown - gone) } : l;
  };
  const setList = (next: ListPayload | ((prev: ListPayload | null) => ListPayload | null)) =>
    setListState((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      return v ? clean(v) : v;
    });

  const startPoll = (p: TaskPayload) => {
    pollTag.current = gens.tag();
    poller.current?.start(p);
  };
  const stopPoll = () => poller.current?.stop();

  useEffect(() => {
    const bridge = makeBridge();
    bridgeRef.current = bridge;
    // The poller's own reads go through the same guard: a fetch or get_task that settles after
    // the card moved on is reported as nothing new.
    const guardedBridge: Bridge = {
      ...bridge,
      getTask: async (id, after) => {
        const r = await gens.run(() => bridge.getTask(id, after), pollTag.current);
        return r.stale ? null : r.value;
      },
    };
    const guardedFetch: typeof fetch = async (...a) => {
      const r = await gens.run(() => fetch(...a), pollTag.current);
      return r.stale ? ({ status: 409, ok: false, json: async () => null } as unknown as Response) : r.value;
    };
    // Poller.start merges each payload into the previous one (state.merge), keeps the
    // transport for the same task and resets it for a new task_id; restarting is safe.
    const report = () => {
      const view = p.view();
      // A host that blocks the card's own requests (bridge-only) would refuse this one too.
      if (reported.current || !hostReady.current || !view || !bridge.hostInfo || p.mode === 'bridge') return;
      reported.current = true;
      void sendHostReport(view, bridge.hostInfo());
    };
    const p = new Poller({
      onMode: (m) => setTransport(m === 'direct' ? 'direct' : p.everDirect ? 'reconnecting' : 'blocked'),
      bridge: guardedBridge,
      fetchImpl: guardedFetch,
      onUpdate: (next) => {
        if (!gens.current(pollTag.current)) return;
        if (deleted.has(next.task_id)) {
          p.stop();
          setMode((m) => ({ kind: 'deleted', fromList: m.kind !== 'list' && m.kind !== 'add' && m.fromList }));
          return;
        }
        taskRef.current = next.task_id;
        setPayload(next);
        report();
      },
    });
    poller.current = p;
    bridge.onPayload((next) => {
      gens.bumpView();
      setTheme(bridge.theme());
      if (deleted.has(next.task_id)) {
        p.stop();
        setMode({ kind: 'deleted', fromList: false });
        return;
      }
      setMode({ kind: 'task', fromList: false });
      startPoll(next);
    });
    bridge.onList((next) => {
      gens.bumpView();
      gens.bumpQuery();
      setTheme(bridge.theme());
      p.stop();
      setListEpoch((e) => e + 1);
      setList(next);
      setMode({ kind: 'list' });
    });
    bridge.onAddFiles?.((next) => {
      gens.bumpView();
      setTheme(bridge.theme());
      p.stop();
      setAdd(next);
      setMode({ kind: 'add' });
    });
    bridge.onThemeChange(setTheme);
    const frame = () => setEmbedded(bridge.embedded ? bridge.embedded() : true);
    bridge.onEmbeddedChange?.(setEmbedded);
    bridge.onConnectError(() => setConnectFailed(true));
    const readModes = () => {
      setModes(bridge.displayModes?.());
      setDisplayMode(bridge.displayMode?.() ?? 'inline');
    };
    bridge.onDisplayModeChange?.(readModes);
    bridge.onReady(() => {
      hostReady.current = true;
      readModes();
      report();
      setTheme(bridge.theme());
      frame();
      setCanAnswer(bridge.canCallTools());
    });
    setTheme(bridge.theme());
    frame();
    return () => p.stop();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Back on the list: restore the scroll position and put focus on the row that was opened.
  useEffect(() => {
    const b = backTo.current;
    if (mode.kind !== 'list' || !b) return;
    backTo.current = null;
    try {
      window.scrollTo(0, b.scrollY);
    } catch {
      /* jsdom and some hosts: no scrolling */
    }
    const row = Array.from(document.querySelectorAll<HTMLElement>('.fc-row')).find((el) => el.dataset.task === b.taskId);
    row?.querySelector<HTMLButtonElement>('.fc-rt')?.focus();
  }, [mode]);

  const answer: AnswerApi = useMemo(
    () => ({
      enabled: canAnswer,
      async send(askId: string, answers: Answers): Promise<AnswerOutcome | Stale> {
        const b = bridgeRef.current;
        const taskId = taskRef.current;
        if (!b || !taskId) return { kind: 'failed', message: 'Reply in the chat to answer.' };
        // Answers are judged by task, not by the view generation: a host result for the same task
        // (the model re-reading it, a reconnect) bumps the view but must not drop this answer.
        // Stale only when the card no longer shows this task, or it was deleted.
        const out = await b.answer(taskId, askId, answers);
        if (shownTask.current !== taskId || deleted.has(taskId)) return STALE;
        // The answer result carries the task's fresh state: fold it in and keep polling.
        if (out.kind !== 'failed' && out.payload && out.payload.task_id === taskId && !deleted.has(taskId)) startPoll(out.payload);
        return out;
      },
    }),
    [canAnswer],
  );

  const download: DownloadApi = useMemo(
    () => ({
      enabled: canAnswer,
      async get(path: string | null): Promise<DownloadOutcome | Stale> {
        const b = bridgeRef.current;
        const taskId = taskRef.current;
        if (!b || !taskId) return { kind: 'failed', message: LINK_FAILED };
        if (deleted.has(taskId)) return STALE;
        // Through the guard, judged by task like answers: a link that arrives after the card shows
        // another task (or the list), or after the task was deleted, is dropped and never opened. A
        // host result for the same task (the model re-reading it) does not drop it.
        const gone = () => shownTask.current !== taskId || deleted.has(taskId);
        const r = await gens.run(() => b.fileLink(taskId, path));
        if (gone()) return STALE;
        if (r.value.kind === 'failed') return r.value;
        const { url, name } = r.value;
        // A host that never answers (a confirm dialog left open) or rejects: show the link itself.
        const opened = await gens.run(() => withTimeout(b.openLink(url), OPEN_LINK_WAIT_MS));
        if (gone()) return STALE;
        return opened.value ? { kind: 'opened' } : { kind: 'link', url, name };
      },
    }),
    [canAnswer],
  );

  const upload: UploadApi = useMemo(() => {
    const b = bridgeRef.current;
    if (!canAnswer || !b?.uploadTicket) return NO_UPLOADS;
    return {
      enabled: true,
      send: (taskId, files, onProgress, instruction) =>
        sendFiles(files, { fetch: (...a) => fetch(...a), ticket: () => b.uploadTicket!(taskId, instruction) }, onProgress),
      tell: (text) => (b.sendMessage ? b.sendMessage(text) : Promise.resolve(false)),
    };
  }, [canAnswer]);

  /** The Poller's view token, for the browser frame feed and input. */
  const frameSource = (): FrameSource | null => {
    const p = poller.current;
    return p ? { view: () => p.view(), renewToken: () => p.renewToken(), bridgeOnly: () => p.mode === 'bridge' } : null;
  };

  const browser: BrowserApi = useMemo(
    () => ({
      modes,
      mode: displayMode,
      feed(onFrame, onStatus) {
        const source = frameSource();
        return source ? new BrowserFeed({ source, onFrame, onStatus }) : null;
      },
      async input(taskId, events) {
        const source = frameSource();
        return source ? postInput(source, taskId, events) : 'failed';
      },
      async control(taskId) {
        const source = frameSource();
        return source ? postControl(source, taskId) : 'failed';
      },
      refresh: () => poller.current?.poke(),
      transport: () => transport,
      ...(canAnswer && bridgeRef.current?.stopTask
        ? {
            async stop() {
              const b = bridgeRef.current;
              const taskId = taskRef.current;
              if (!b?.stopTask || !taskId) return false;
              const ok = await b.stopTask(taskId);
              if (ok) poller.current?.poke();
              return ok;
            },
          }
        : {}),
      container: () => bridgeRef.current?.hostInfo?.().container,
      async requestDisplayMode(mode) {
        const b = bridgeRef.current;
        return b?.requestDisplayMode ? b.requestDisplayMode(mode) : (b?.displayMode?.() ?? 'inline');
      },
    }),
    [modes, displayMode, canAnswer, transport],
  );

  // The full-screen file preview: on any host that offers full screen, forwards the card's tool
  // calls (the file link) and where the viewers can load. Codex offers full screen but gives an
  // app no way to open a file in its own viewer, so this is its only preview. A host
  // without full screen keeps a plain click, and one that refuses it falls back to a download.
  const preview: PreviewGate = useMemo(() => {
    const b = bridgeRef.current;
    const enabled = canAnswer && !!modes?.includes('fullscreen') && viewersAvailable();
    if (!b || !enabled) return { ...NO_PREVIEW, mode: displayMode };
    return {
      enabled, mode: displayMode,
      open: async () => (await (b.requestDisplayMode?.('fullscreen') ?? Promise.resolve('inline'))) === 'fullscreen',
      close: async () => { await b.requestDisplayMode?.('inline'); },
      api: { bytes: (path) => fetchFileBytes((p) => b.fileLink(taskRef.current ?? '', p), path), load: loadViewer },
      safeArea: b.safeArea?.(),
    };
  }, [canAnswer, modes, displayMode]);

  const actions: ListActions = useMemo(
    () => ({
      enabled: canAnswer,
      async query(q: ListQuery, append: boolean): Promise<string | null> {
        const b = bridgeRef.current;
        if (!b) return LIST_FAILED;
        gens.bumpQuery();
        const r = await gens.run(() => b.listTasks(q));
        // Superseded by a newer request, a navigation or a new list from the host: drop it silently.
        if (r.stale) return null;
        const out = r.value;
        if (out.kind === 'failed') return out.message;
        setList((prev) => (append && prev ? appendPage(prev, out.list) : { ...out.list, org: out.list.org ?? prev?.org ?? null }));
        return null;
      },
      async open(taskId: string): Promise<string | null> {
        const b = bridgeRef.current;
        if (!b) return OPEN_FAILED;
        if (deleted.has(taskId)) return TASK_DELETED;
        gens.bumpView();
        let r: Guarded<TaskPayload | null>;
        try {
          r = await gens.run(() => b.getTask(taskId, 0));
        } catch {
          r = { stale: false, value: null };
        }
        // The user opened another task, went back, or the host showed something else meanwhile.
        if (r.stale) return null;
        if (deleted.has(taskId)) return TASK_DELETED;
        const p = r.value;
        if (!p || p.task_id !== taskId) return OPEN_FAILED;
        backTo.current = { scrollY: typeof window.scrollY === 'number' ? window.scrollY : 0, taskId };
        setMode({ kind: 'task', fromList: true });
        startPoll(p);
        return null;
      },
      async remove(taskId: string): Promise<DeleteOutcome | Stale> {
        const b = bridgeRef.current;
        if (!b) return { kind: 'failed', message: "Couldn't delete the task. Try again." };
        const r = await gens.run(() => b.deleteTask(taskId));
        // A deletion is a fact whenever it lands: remember it (even when stale), so no later list,
        // detail or poll result brings the task back. setList re-applies the filter to the rows.
        if (r.value.kind === 'deleted') {
          deleted.add(taskId);
          setList((prev) => prev);
        }
        // The outcome is local to the row: a failure is shown even if a filter change or page load
        // happened meanwhile (the row is still on screen); a stale success removes the row as usual.
        return r.value;
      },
    }),
    [canAnswer],
  );

  const back = () => {
    gens.bumpView();
    stopPoll();
    setMode({ kind: 'list' });
  };

  shownTask.current = mode.kind === 'task' && payload ? payload.task_id : null;
  if (mode.kind === 'add' && add) return <AddFiles key={add.task_id} add={add} api={upload} theme={theme} embedded={embedded} />;
  if (mode.kind === 'list' && list) return <TaskList key={listEpoch} list={list} theme={theme} embedded={embedded} actions={actions} />;
  if (mode.kind === 'deleted') {
    return (
      <article class={cardClass(embedded)} data-theme={theme} aria-label="Frontier task">
        {mode.fromList && list ? (
          <div class="fc-backbar">
            <button type="button" class="fc-back" onClick={back}>All tasks</button>
          </div>
        ) : null}
        <p class="fc-note fc-deleted" role="status">{TASK_DELETED}</p>
      </article>
    );
  }
  if (payload && mode.kind === 'task') {
    return (
      <Card key={payload.task_id} payload={payload} theme={theme} embedded={embedded} answer={answer} download={download} browser={browser} upload={upload} preview={preview}
        onBack={mode.fromList && list ? back : undefined} />
    );
  }
  if (connectFailed) {
    return (
      <p class="fc-loading" role="alert">
        Couldn't connect to the chat app. Reload the conversation.
      </p>
    );
  }
  return <p class="fc-loading">Loading the task…</p>;
}
