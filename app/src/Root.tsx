import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AnswerOutcome, Answers, Bridge } from './bridge';
import { createHostBridge } from './hostBridge';
import { Poller } from './poller';
import { Card, type AnswerApi } from './view/Card';
import type { TaskPayload } from './types';

export function Root({ makeBridge = () => createHostBridge() }: { makeBridge?: () => Bridge }) {
  const [payload, setPayload] = useState<TaskPayload | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [connectFailed, setConnectFailed] = useState(false);
  const [canAnswer, setCanAnswer] = useState(false);
  const poller = useRef<Poller | null>(null);
  const bridgeRef = useRef<Bridge | null>(null);
  const taskRef = useRef<string | null>(null);

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
      setTheme(bridge.theme());
      p.start(next);
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

  if (payload) return <Card payload={payload} theme={theme} answer={answer} />;
  if (connectFailed) {
    return (
      <p class="fc-loading" role="alert">
        Couldn't connect to the chat app. Reload the conversation.
      </p>
    );
  }
  return <p class="fc-loading">Loading the task…</p>;
}
