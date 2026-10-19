import { App } from '@modelcontextprotocol/ext-apps';
import type { AnswerOutcome, Bridge, DeleteOutcome, LinkOutcome, ListOutcome } from './bridge';
import { parseList, type ListPayload } from './list';
import { parsePayload, type TaskPayload } from './types';

export const SEND_FAILED = "Couldn't send your answer. Try again, or reply in the chat.";
export const LIST_FAILED = "Couldn't load your tasks. Try again, or ask in the chat.";
export const DELETE_FAILED = "Couldn't delete the task. Try again.";
export const LINK_FAILED = "Couldn't prepare the download. Try again.";

/** Only an https URL is ever opened or shown as a link (never javascript:, data: or the like). */
export function safeHttps(u: unknown): string | null {
  if (typeof u !== 'string' || u.length > 8192) return null;
  try {
    return new URL(u).protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** A short, plain message from an error tool result, or the generic line. */
function errorLine(r: { structuredContent?: unknown; content?: unknown } | undefined, fallback = SEND_FAILED): string {
  const sc = r?.structuredContent as { error?: { message?: unknown } } | undefined;
  const msg = sc && typeof sc === 'object' && sc.error && typeof sc.error === 'object' ? sc.error.message : undefined;
  if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 300);
  return fallback;
}

/**
 * Adapter over the MCP Apps `App` class (@modelcontextprotocol/ext-apps 2.0.3).
 * Verified API: `new App(appInfo, capabilities?, options?)` (`options.autoResize`, default true,
 * reports the document's size to the host through `ui/notifications/size-changed` whenever it
 * changes), `app.ontoolresult = (params) => ...` (`params.structuredContent`), `app.connect(transport?)`
 * (defaults to a postMessage transport to the parent window), `app.callServerTool({ name, arguments })`
 * -> CallToolResult, `app.getHostCapabilities()?.serverTools` (the host proxies app tool calls),
 * `app.getHostContext()?.theme`, `app.onhostcontextchanged`, `app.openLink({ url })` -> `{ isError? }`
 * (`ui/open-link`; offered when `getHostCapabilities()?.openLinks` is set).
 */
export function createHostBridge(
  app: App = new App({ name: 'frontier-task', version: '0.2.0' }, {}, { autoResize: true }),
): Bridge {
  const listeners: ((p: TaskPayload) => void)[] = [];
  // The host can deliver the first tool result before the card registers its listener; keep the
  // latest one and replay it on registration so the card renders at once, not after a poll.
  let latest: TaskPayload | null = null;
  const listListeners: ((l: ListPayload) => void)[] = [];
  let latestList: ListPayload | null = null;
  // Handlers must be set before connect() so the first tool result is not missed.
  app.ontoolresult = (result: { structuredContent?: unknown }) => {
    const list = parseList(result?.structuredContent);
    if (list) {
      latestList = list;
      latest = null;
      for (const l of listListeners) l(list);
      return;
    }
    const sc = parsePayload(result?.structuredContent);
    if (sc) {
      latest = sc;
      latestList = null;
      for (const l of listeners) l(sc);
    }
  };
  const themeOf = (ctx?: { theme?: string } | null): 'light' | 'dark' =>
    ctx?.theme === 'dark' ? 'dark' : 'light';
  const themeListeners: ((t: 'light' | 'dark') => void)[] = [];
  // MCP Apps hosts (Codex, ChatGPT, Claude) draw their own rounded, bordered frame around an
  // inline or pip view, and the host context has no "frame" hint; only fullscreen fills a bare
  // panel. So the card is embedded unless the host says fullscreen.
  const embeddedOf = (ctx?: { displayMode?: unknown } | null): boolean => ctx?.displayMode !== 'fullscreen';
  const embeddedListeners: ((e: boolean) => void)[] = [];
  app.onhostcontextchanged = (params: { theme?: string; displayMode?: unknown }) => {
    // The notification carries only the changed fields; fall back to the merged context.
    const t = params && 'theme' in params ? themeOf(params) : themeOf(app.getHostContext?.());
    for (const l of themeListeners) l(t);
    if (params && 'displayMode' in params) {
      const e = embeddedOf(params);
      for (const l of embeddedListeners) l(e);
    }
  };
  const errorListeners: ((e: unknown) => void)[] = [];
  const readyListeners: (() => void)[] = [];
  let connectError: { e: unknown } | null = null;
  let ready = false;
  void Promise.resolve(app.connect())
    .then(() => {
      ready = true;
      for (const l of readyListeners) l();
    })
    .catch((e: unknown) => {
      // Not inside a host (or the handshake failed): the card shows a connect error.
      console.warn('[frontier-task] host connection failed', e);
      connectError = { e };
      for (const l of errorListeners) l(e);
    });
  return {
    onPayload: (cb) => {
      listeners.push(cb);
      if (latest) cb(latest);
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
    embedded: () => embeddedOf(app.getHostContext?.()),
    onEmbeddedChange: (cb) => {
      embeddedListeners.push(cb);
    },
    onConnectError: (cb) => {
      errorListeners.push(cb);
      if (connectError) cb(connectError.e);
    },
    canCallTools: () => ready && !!app.getHostCapabilities?.()?.serverTools,
    onReady: (cb) => {
      readyListeners.push(cb);
      if (ready) cb();
    },
    onList: (cb) => {
      listListeners.push(cb);
      if (latestList) cb(latestList);
    },
    async listTasks(q): Promise<ListOutcome> {
      const args: Record<string, unknown> = { days: q.days };
      if (q.status) args.status = q.status;
      if (q.source) args.source = q.source;
      if (q.cursor) args.cursor = q.cursor;
      try {
        const r = await app.callServerTool({ name: 'frontier_list_tasks', arguments: args });
        if (!r || r.isError) return { kind: 'failed', message: errorLine(r, LIST_FAILED) };
        const list = parseList(r.structuredContent);
        return list ? { kind: 'ok', list } : { kind: 'failed', message: LIST_FAILED };
      } catch {
        return { kind: 'failed', message: LIST_FAILED };
      }
    },
    async deleteTask(taskId): Promise<DeleteOutcome> {
      let r: Awaited<ReturnType<App['callServerTool']>> | undefined;
      try {
        r = await app.callServerTool({ name: 'frontier_delete_task', arguments: { task_id: taskId } });
      } catch {
        return { kind: 'failed', message: DELETE_FAILED };
      }
      // Deleted elsewhere already (another device or a second click): the task is gone either way.
      const code = (r?.structuredContent as { error?: { code?: unknown } } | undefined)?.error?.code;
      if (r?.isError && code === 'task_not_found') return { kind: 'deleted' };
      if (!r || r.isError) return { kind: 'failed', message: errorLine(r, DELETE_FAILED) };
      const sc = r.structuredContent as { accepted?: unknown; reason?: unknown } | undefined;
      if (sc?.accepted === true) return { kind: 'deleted' };
      if (sc?.accepted === false) {
        const reason = typeof sc.reason === 'string' && sc.reason.trim() ? sc.reason.trim().slice(0, 300) : DELETE_FAILED;
        return { kind: 'refused', reason };
      }
      return { kind: 'failed', message: DELETE_FAILED };
    },
    async fileLink(taskId, path): Promise<LinkOutcome> {
      let r: Awaited<ReturnType<App['callServerTool']>> | undefined;
      try {
        r = await app.callServerTool({
          name: 'frontier_file_link',
          arguments: path === null ? { task_id: taskId } : { task_id: taskId, path },
        });
      } catch {
        return { kind: 'failed', message: LINK_FAILED };
      }
      if (!r || r.isError) return { kind: 'failed', message: errorLine(r, LINK_FAILED) };
      const sc = r.structuredContent as { url?: unknown; name?: unknown } | undefined;
      const url = safeHttps(sc?.url);
      if (!url) return { kind: 'failed', message: LINK_FAILED };
      const name = typeof sc?.name === 'string' && sc.name.trim() ? sc.name.trim().slice(0, 300) : 'download';
      return { kind: 'ok', url, name };
    },
    async openLink(url): Promise<boolean> {
      if (!app.getHostCapabilities?.()?.openLinks || typeof app.openLink !== 'function') return false;
      try {
        const r = await app.openLink({ url });
        return !r?.isError;
      } catch {
        return false;
      }
    },
    async answer(taskId, askId, answers): Promise<AnswerOutcome> {
      let r: Awaited<ReturnType<App['callServerTool']>> | undefined;
      try {
        r = await app.callServerTool({
          name: 'frontier_answer',
          arguments: { task_id: taskId, ask_id: askId, answers },
        });
      } catch {
        return { kind: 'failed', message: SEND_FAILED };
      }
      if (!r || r.isError) return { kind: 'failed', message: errorLine(r) };
      const payload = parsePayload(r.structuredContent);
      const sc = r.structuredContent as { accepted?: unknown; reason?: unknown } | undefined;
      if (sc?.accepted === false) {
        const reason = typeof sc.reason === 'string' && sc.reason.trim() ? sc.reason.trim().slice(0, 300) : SEND_FAILED;
        return { kind: 'refused', reason, payload };
      }
      if (sc?.accepted === true) return { kind: 'accepted', payload };
      return { kind: 'failed', message: SEND_FAILED };
    },
  };
}
