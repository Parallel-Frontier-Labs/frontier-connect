import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from './bridge';
import { createHostBridge } from './hostBridge';
import { Poller } from './poller';
import { Card } from './view/Card';
import type { TaskPayload } from './types';

export function Root({ makeBridge = () => createHostBridge() }: { makeBridge?: () => Bridge }) {
  const [payload, setPayload] = useState<TaskPayload | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [connectFailed, setConnectFailed] = useState(false);
  const poller = useRef<Poller | null>(null);

  useEffect(() => {
    const bridge = makeBridge();
    // Poller.start merges each payload into the previous one (state.merge), keeps the
    // transport for the same task and resets it for a new task_id; restarting is safe.
    const p = new Poller({ bridge, onUpdate: setPayload });
    poller.current = p;
    bridge.onPayload((next) => {
      setTheme(bridge.theme());
      p.start(next);
    });
    bridge.onThemeChange(setTheme);
    bridge.onConnectError(() => setConnectFailed(true));
    setTheme(bridge.theme());
    return () => p.stop();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  if (payload) return <Card payload={payload} theme={theme} />;
  if (connectFailed) {
    return (
      <p class="loading" role="alert">
        Couldn't connect to the chat app. Reload the conversation.
      </p>
    );
  }
  return <p class="loading">Loading the task…</p>;
}
