import { App } from '@modelcontextprotocol/ext-apps';
import type { AnswerOutcome, Bridge, DeleteOutcome, HostInfo, LinkOutcome, ListOutcome } from './bridge';
import { parseAddFiles, type AddFilesPayload } from './upload/addFiles';
import type { TicketResult } from './upload/transfer';
import { parseList, type ListPayload } from './list';
import { parsePayload, type TaskPayload } from './types';

export const SEND_FAILED = "Couldn't send your answer. Try again, or reply in the chat.";
export const LIST_FAILED = "Couldn't load your tasks. Try again, or ask in the chat.";
export const DELETE_FAILED = "Couldn't delete the task. Try again.";
export const UPLOAD_FAILED = "Couldn't start the upload. Try again.";
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

const MODES = ['inline', 'fullscreen', 'pip'] as const;
type Mode = (typeof MODES)[number];
const modeOf = (v: unknown): Mode | undefined => MODES.find((m) => m === v);
/** The modes the card itself supports, declared to the host at the handshake. */
export const appCapabilities: { availableDisplayModes: Mode[] } = { availableDisplayModes: ['inline', 'fullscreen'] };

type Ctx = {
  theme?: string; displayMode?: unknown; availableDisplayModes?: unknown; platform?: unknown; containerDimensions?: unknown;
} | null | undefined;
const cap64 = (v: unknown): string | undefined => (typeof v === 'string' && v ? v.slice(0, 64) : undefined);
const dim = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
const modesOf = (ctx: Ctx): string[] | undefined =>
  Array.isArray(ctx?.availableDisplayModes) ? ctx.availableDisplayModes.filter((m): m is Mode => !!modeOf(m)) : undefined;

/**
 * Adapter over the MCP Apps `App` class (@modelcontextprotocol/ext-apps 2.0.3).
 * Verified API: `new App(appInfo, capabilities?, options?)` (`options.autoResize`, default true,
 * reports the document's size to the host through `ui/notifications/size-changed` whenever it
 * changes), `app.ontoolresult = (params) => ...` (`params.structuredContent`), `app.connect(transport?)`
 * (defaults to a postMessage transport to the parent window), `app.callServerTool({ name, arguments })`
 * -> CallToolResult, `app.getHostCapabilities()?.serverTools` (the host proxies app tool calls),
 * `app.getHostContext()?.theme`, `app.onhostcontextchanged`, `app.openLink({ url })` -> `{ isError? }`
 * (`ui/open-link`; offered when `getHostCapabilities()?.openLinks` is set),
 * `app.requestDisplayMode({ mode })` -> `{ mode }` (the mode the host applied), `app.getHostVersion()`
 * -> `{ name, version }`, host context `displayMode`, `availableDisplayModes`, `platform`,
 * `containerDimensions`.
 */
export function createHostBridge(
  app: App = new App({ name: 'frontier-task', version: '0.2.0' }, appCapabilities, { autoResize: true }),
): Bridge {
  const listeners: ((p: TaskPayload) => void)[] = [];
  // The host can deliver the first tool result before the card registers its listener; keep the
  // latest one and replay it on registration so the card renders at once, not after a poll.
  let latest: TaskPayload | null = null;
  const listListeners: ((l: ListPayload) => void)[] = [];
  let latestList: ListPayload | null = null;
  const addListeners: ((a: AddFilesPayload) => void)[] = [];
  let latestAdd: AddFilesPayload | null = null;
  // Handlers must be set before connect() so the first tool result is not missed.
  app.ontoolresult = (result: { structuredContent?: unknown }) => {
    const add = parseAddFiles(result?.structuredContent);
    if (add) {
      latestAdd = add;
      latest = null;
      latestList = null;
      for (const l of addListeners) l(add);
      return;
    }
    const list = parseList(result?.structuredContent);
    if (list) {
      latestList = list;
      latestAdd = null;
      latest = null;
      for (const l of listListeners) l(list);
      return;
    }
    const sc = parsePayload(result?.structuredContent);
    if (sc) {
      latest = sc;
      latestList = null;
      latestAdd = null;
      for (const l of listeners) l(sc);
    }
  };
  const themeOf = (ctx?: { theme?: string } | null): 'light' | 'dark' =>
    ctx?.theme === 'dark' ? 'dark' : 'light';
  const themeListeners: ((t: 'light' | 'dark') => void)[] = [];
  // MCP Apps hosts (Codex, ChatGPT, Claude) draw their own rounded, bordered frame around an
  // inline or pip view, and the host context has no "frame" hint; only fullscreen fills a bare
  // panel. So the card is embedded unless the host says fullscreen.
  const embeddedListeners: ((e: boolean) => void)[] = [];
  const modeListeners: ((m: string) => void)[] = [];
  const ctx = (): Ctx => app.getHostContext?.() as Ctx;
  // The mode the host applied in answer to the card's own request, until the host context says
  // otherwise (a host may answer the request without sending a context change).
  let granted: Mode | null = null;
  const displayMode = (): Mode => granted ?? modeOf(ctx()?.displayMode) ?? 'inline';
  const embeddedOf = (m: Mode): boolean => m !== 'fullscreen';
  // The last mode listeners heard about. Tracked here, not read back from the context, because the
  // context is already merged with a change by the time the change is announced.
  let last: Mode = displayMode();
  const announce = (m: Mode, always = false) => {
    const before = last;
    last = m;
    if (m !== before || always) for (const l of modeListeners) l(m);
    if (embeddedOf(m) !== embeddedOf(before)) for (const l of embeddedListeners) l(embeddedOf(m));
  };
  app.onhostcontextchanged = (params: { theme?: string; displayMode?: unknown; availableDisplayModes?: unknown }) => {
    // The notification carries only the changed fields; fall back to the merged context.
    const t = params && 'theme' in params ? themeOf(params) : themeOf(app.getHostContext?.());
    for (const l of themeListeners) l(t);
    const modes = !!params && 'availableDisplayModes' in params;
    if (params && 'displayMode' in params) {
      granted = null;
      announce(modeOf(params.displayMode) ?? 'inline', modes);
    } else if (modes) {
      announce(displayMode(), true);
    }
  };
  const errorListeners: ((e: unknown) => void)[] = [];
  const readyListeners: (() => void)[] = [];
  let connectError: { e: unknown } | null = null;
  let ready = false;
  void Promise.resolve(app.connect())
    .then(() => {
      ready = true;
      // The handshake brought the initial context: the starting point, not a change.
      last = displayMode();
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
    embedded: () => embeddedOf(displayMode()),
    onEmbeddedChange: (cb) => {
      embeddedListeners.push(cb);
    },
    displayModes: () => modesOf(ctx()),
    displayMode,
    async requestDisplayMode(mode) {
      if (typeof app.requestDisplayMode !== 'function') return displayMode();
      try {
        const r = await app.requestDisplayMode({ mode });
        const applied = modeOf(r?.mode);
        if (!applied) return displayMode();
        granted = applied;
        announce(applied);
        return applied;
      } catch {
        return displayMode();
      }
    },
    onDisplayModeChange: (cb) => {
      modeListeners.push(cb);
    },
    hostInfo(): HostInfo {
      const c = ctx();
      const info: HostInfo = {};
      let v: { name?: unknown; version?: unknown } | undefined;
      try {
        v = app.getHostVersion?.() as typeof v;
      } catch {
        v = undefined;
      }
      const name = cap64(v?.name);
      const version = cap64(v?.version);
      if (name || version) info.host = { ...(name ? { name } : {}), ...(version ? { version } : {}) };
      const platform = (['web', 'desktop', 'mobile'] as const).find((x) => x === c?.platform);
      if (platform) info.platform = platform;
      info.displayMode = displayMode();
      const modes = modesOf(c);
      if (modes) info.displayModes = modes.slice(0, 8);
      const d = c?.containerDimensions && typeof c.containerDimensions === 'object' ? (c.containerDimensions as Record<string, unknown>) : null;
      if (d) {
        const box: NonNullable<HostInfo['container']> = {};
        for (const k of ['width', 'height', 'maxWidth', 'maxHeight'] as const) {
          const n = dim(d[k]);
          if (n !== undefined) box[k] = n;
        }
        if (Object.keys(box).length) info.container = box;
      }
      return info;
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
    onAddFiles: (cb) => {
      addListeners.push(cb);
      if (latestAdd) cb(latestAdd);
    },
    async uploadTicket(taskId, instruction): Promise<TicketResult> {
      let r: Awaited<ReturnType<App['callServerTool']>> | undefined;
      try {
        r = await app.callServerTool({
          name: 'frontier_request_upload',
          arguments: instruction ? { task_id: taskId, instruction } : { task_id: taskId },
        });
      } catch {
        return { kind: 'failed', message: UPLOAD_FAILED };
      }
      if (!r || r.isError) return { kind: 'failed', message: errorLine(r, UPLOAD_FAILED) };
      const url = safeHttps((r.structuredContent as { ticket_url?: unknown } | undefined)?.ticket_url);
      return url ? { kind: 'ok', url } : { kind: 'failed', message: UPLOAD_FAILED };
    },
    async sendMessage(text): Promise<boolean> {
      if (!app.getHostCapabilities?.()?.message || typeof app.sendMessage !== 'function') return false;
      try {
        const r = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
        return !r?.isError;
      } catch {
        return false;
      }
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
    async stopTask(taskId): Promise<boolean> {
      try {
        const r = await app.callServerTool({ name: 'frontier_stop_task', arguments: { task_id: taskId } });
        return !!r && !r.isError;
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
