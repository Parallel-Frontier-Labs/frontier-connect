import { App } from '@modelcontextprotocol/ext-apps';
import type { Bridge } from './bridge';
import { parsePayload, type TaskPayload } from './types';

/**
 * Adapter over the MCP Apps `App` class (@modelcontextprotocol/ext-apps 2.0.3).
 * Verified API: `new App(appInfo, capabilities?, options?)`, `app.ontoolresult = (params) => ...`
 * (`params.structuredContent`), `app.connect(transport?)` (defaults to a postMessage transport to
 * the parent window), `app.callServerTool({ name, arguments })` -> CallToolResult,
 * `app.getHostContext()?.theme`, `app.onhostcontextchanged`.
 */
export function createHostBridge(
  app: App = new App({ name: 'frontier-task', version: '0.1.0' }),
): Bridge {
  const listeners: ((p: TaskPayload) => void)[] = [];
  // Handlers must be set before connect() so the first tool result is not missed.
  app.ontoolresult = (result: { structuredContent?: unknown }) => {
    const sc = parsePayload(result?.structuredContent);
    if (sc) for (const l of listeners) l(sc);
  };
  const themeOf = (ctx?: { theme?: string } | null): 'light' | 'dark' =>
    ctx?.theme === 'dark' ? 'dark' : 'light';
  const themeListeners: ((t: 'light' | 'dark') => void)[] = [];
  app.onhostcontextchanged = (params: { theme?: string }) => {
    // The notification carries only the changed fields; fall back to the merged context.
    const t = params && 'theme' in params ? themeOf(params) : themeOf(app.getHostContext?.());
    for (const l of themeListeners) l(t);
  };
  const errorListeners: ((e: unknown) => void)[] = [];
  let connectError: { e: unknown } | null = null;
  void Promise.resolve(app.connect()).catch((e: unknown) => {
    // Not inside a host (or the handshake failed): the card shows a connect error.
    console.warn('[frontier-task] host connection failed', e);
    connectError = { e };
    for (const l of errorListeners) l(e);
  });
  return {
    onPayload: (cb) => {
      listeners.push(cb);
    },
    async getTask(taskId, after) {
      const r = await app.callServerTool({
        name: 'frontier_get_task',
        arguments: { task_id: taskId, after },
      });
      return r?.isError ? null : parsePayload(r?.structuredContent);
    },
    theme: () => themeOf(app.getHostContext?.()),
    onThemeChange: (cb) => {
      themeListeners.push(cb);
    },
    onConnectError: (cb) => {
      errorListeners.push(cb);
      if (connectError) cb(connectError.e);
    },
  };
}
