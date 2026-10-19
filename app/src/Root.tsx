import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AnswerOutcome, Answers, Bridge, DeleteOutcome, ListQuery } from './bridge';
import { createHostBridge, LIST_FAILED } from './hostBridge';
import { appendPage, type ListPayload } from './list';
import { Poller } from './poller';
import { Card, type AnswerApi } from './view/Card';
import { TaskList, type ListActions } from './view/TaskList';
import type { TaskPayload } from './types';

const sameFilters = (a: ListPayload | null, b: ListPayload | null): boolean =>
  !!a && !!b && a.filters.days === b.filters.days && a.filters.status === b.filters.status && a.filters.source === b.filters.source;

export const OPEN_FAILED = "Couldn't open the task. Try again, or ask in the chat.";

/**
 * What the card shows: a task (from a task tool result, or opened from the list), or the list of
 * the user's tasks. The list state (filters, loaded rows, scroll) lives here, so "← All tasks"
 * comes back to exactly where the user was.
 */
type Mode = { kind: 'task'; fromList: boolean } | { kind: 'list' };

export function Root({ makeBridge = () => createHostBridge() }: { makeBridge?: () => Bridge }) {
  const [payload, setPayload] = useState<TaskPayload | null>(null);
  const [list, setList] = useState<ListPayload | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'task', fromList: false });
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [connectFailed, setConnectFailed] = useState(false);
  const [canAnswer, setCanAnswer] = useState(false);
  const poller = useRef<Poller | null>(null);
  const bridgeRef = useRef<Bridge | null>(null);
  const taskRef = useRef<string | null>(null);
  const listRef = useRef<ListPayload | null>(null);
  const backTo = useRef<{ scrollY: number; taskId: string } | null>(null);
  // Generations: a response is applied only if nothing newer started after it was asked for.
  // `nav` moves on every view change (open, back, a host result); `query` on every list request
  // and every list result from the host, so a stale page or filter answer is dropped.
  const nav = useRef(0);
  const query = useRef(0);
  // Remounts the list view when the host sends a fresh list (resets its menus and spinners).
  const [listEpoch, setListEpoch] = useState(0);
  listRef.current = list;

  useEffect(() => {
    const bridge = makeBridge();
    bridgeRef.current = bridge;
    // Poller.start merges each payload into the previous one (state.merge), keeps the
    // transport for the same task and resets it for a new task_id; restarting is safe.
    const p = new Poller({
      bridge,
      onUpdate: (next) => {
        taskRef.current = next.task_id;
        setPayload(next);
      },
    });
    poller.current = p;
    bridge.onPayload((next) => {
      nav.current++;
      setTheme(bridge.theme());
      setMode({ kind: 'task', fromList: false });
      p.start(next);
    });
    bridge.onList((next) => {
      nav.current++;
      query.current++;
      setTheme(bridge.theme());
      p.stop();
      setListEpoch((e) => e + 1);
      setList(next);
      setMode({ kind: 'list' });
    });
    bridge.onThemeChange(setTheme);
    bridge.onConnectError(() => setConnectFailed(true));
    bridge.onReady(() => {
      setTheme(bridge.theme());
      setCanAnswer(bridge.canCallTools());
    });
    setTheme(bridge.theme());
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
      async send(askId: string, answers: Answers): Promise<AnswerOutcome> {
        const b = bridgeRef.current;
        const taskId = taskRef.current;
        if (!b || !taskId) return { kind: 'failed', message: 'Reply in the chat to answer.' };
        const out = await b.answer(taskId, askId, answers);
        // The answer result carries the task's fresh state: fold it in and keep polling.
        if (out.kind !== 'failed' && out.payload && out.payload.task_id === taskId) poller.current?.start(out.payload);
        return out;
      },
    }),
    [canAnswer],
  );

  const actions: ListActions = useMemo(
    () => ({
      enabled: canAnswer,
      async query(q: ListQuery, append: boolean): Promise<string | null> {
        const b = bridgeRef.current;
        if (!b) return LIST_FAILED;
        const gen = ++query.current;
        const asked = listRef.current;
        const out = await b.listTasks(q);
        // Superseded by a newer request or a new list from the host: drop it silently.
        if (gen !== query.current) return null;
        if (out.kind === 'failed') return out.message;
        setList((prev) => {
          if (!append) return { ...out.list, org: out.list.org ?? prev?.org ?? null };
          // A page belongs to the list it was asked for: same filters, and that list is still shown.
          if (!prev || (prev !== asked && !sameFilters(prev, asked))) return prev;
          return appendPage(prev, out.list);
        });
        return null;
      },
      async open(taskId: string): Promise<string | null> {
        const b = bridgeRef.current;
        if (!b) return OPEN_FAILED;
        const gen = ++nav.current;
        let p: TaskPayload | null = null;
        try {
          p = await b.getTask(taskId, 0);
        } catch {
          p = null;
        }
        // The user opened another task, went back, or the host showed something else meanwhile.
        if (gen !== nav.current) return null;
        if (!p || p.task_id !== taskId) return OPEN_FAILED;
        backTo.current = { scrollY: typeof window.scrollY === 'number' ? window.scrollY : 0, taskId };
        setMode({ kind: 'task', fromList: true });
        poller.current?.start(p);
        return null;
      },
      async remove(taskId: string): Promise<DeleteOutcome> {
        const b = bridgeRef.current;
        if (!b) return { kind: 'failed', message: "Couldn't delete the task. Try again." };
        const out = await b.deleteTask(taskId);
        if (out.kind === 'deleted') {
          // Functional: applied to whatever the list is now (another delete or a refresh may have landed).
          setList((prev) =>
            prev && prev.items.some((i) => i.task_id === taskId)
              ? {
                  ...prev,
                  items: prev.items.filter((i) => i.task_id !== taskId),
                  total: Math.max(0, prev.total - 1),
                  shown: Math.max(0, prev.shown - 1),
                }
              : prev,
          );
        }
        return out;
      },
    }),
    [canAnswer],
  );

  const back = () => {
    nav.current++;
    poller.current?.stop();
    setMode({ kind: 'list' });
  };

  if (mode.kind === 'list' && list) return <TaskList key={listEpoch} list={list} theme={theme} actions={actions} />;
  if (payload && mode.kind === 'task') {
    return <Card payload={payload} theme={theme} answer={answer} onBack={mode.fromList && list ? back : undefined} />;
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
