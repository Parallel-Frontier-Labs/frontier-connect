import type { ListPayload, ListStatus, Source } from './list';
import type { TaskPayload } from './types';
import type { AddFilesPayload } from './upload/addFiles';
import type { TicketResult } from './upload/transfer';

/** The answer value frontier_answer takes: a question's Answer list or a form submission. */
export type Answers = Record<string, unknown>[] | { values: Record<string, unknown> } | { deferred: true };

/** What came of a card answer. `payload` is the fresh task state the tool returns, when it parsed. */
export type AnswerOutcome =
  | { kind: 'accepted'; payload: TaskPayload | null }
  | { kind: 'refused'; reason: string; payload: TaskPayload | null }
  | { kind: 'failed'; message: string };

/** A result dropped because the card moved on (another view, task or query) before it arrived. */
export type Stale = { kind: 'stale' };

export interface ListQuery { days: number; status?: ListStatus | null; source?: Source | null; cursor?: string | null }
export type ListOutcome = { kind: 'ok'; list: ListPayload } | { kind: 'failed'; message: string };
/** A browser link for one delivered file or the zipped folder (frontier_file_link). */
export type LinkOutcome = { kind: 'ok'; url: string; name: string } | { kind: 'failed'; message: string };
/** What came of a download click: the host opened the link, or the card shows it as a plain link. */
export type DownloadOutcome = { kind: 'opened' } | { kind: 'link'; url: string; name: string } | { kind: 'failed'; message: string };
export type DeleteOutcome = { kind: 'deleted' } | { kind: 'refused'; reason: string } | { kind: 'failed'; message: string };

/** What the card tells the server about the host (no user data): see Bridge.hostInfo. */
export interface HostInfo {
  host?: { name?: string; version?: string };
  platform?: 'web' | 'desktop' | 'mobile';
  displayModes?: string[];
  displayMode?: string;
  container?: { width?: number; height?: number; maxWidth?: number; maxHeight?: number };
}

export interface Bridge {
  /** Every tool result the host shows this card for (start_task, get_task, wait_task). */
  onPayload(cb: (p: TaskPayload) => void): void;
  /** frontier_get_task through the host (runs under the user's OAuth grant). */
  getTask(taskId: string, after: number): Promise<TaskPayload | null>;
  theme(): 'light' | 'dark';
  /** The host changed its theme (light/dark toggle) while the card is open. */
  onThemeChange(cb: (t: 'light' | 'dark') => void): void;
  /** True while the host shows the card inside its own frame (every display mode but fullscreen,
   * and whenever the host does not say): the card then draws no outer border, radius or shadow,
   * so the frame is not doubled. Optional: a bridge without it counts as embedded. */
  embedded?(): boolean;
  /** The host changed its display mode (inline, pip, fullscreen) while the card is open. */
  onEmbeddedChange?(cb: (embedded: boolean) => void): void;
  /** The host handshake failed (not inside a host, or it refused). Fires at most once, even if registered late. */
  onConnectError(cb: (e: unknown) => void): void;
  /** True once the host said it forwards the card's own tool calls (answers from the card). */
  canCallTools(): boolean;
  /** The handshake finished (capabilities known). Fires at most once, even if registered late. */
  onReady(cb: () => void): void;
  /** frontier_answer through the host. Never retried: a timeout or error is reported as failed. */
  answer(taskId: string, askId: string, answers: Answers): Promise<AnswerOutcome>;
  /** frontier_list_tasks tool results the host shows this card for ("Your Frontier tasks"). */
  onList(cb: (l: ListPayload) => void): void;
  /** frontier_list_tasks from the card: a filter change or "Show more". */
  listTasks(q: ListQuery): Promise<ListOutcome>;
  /** frontier_delete_task (app-only): only ever called from the user's click on Delete. Never retried. */
  deleteTask(taskId: string): Promise<DeleteOutcome>;
  /** frontier_file_link (app-only): a presigned link for one delivered file (`path`, as the card
   * shows it) or the zipped folder (`path` null). Only ever called from the user's click. */
  fileLink(taskId: string, path: string | null): Promise<LinkOutcome>;
  /** Ask the host to open `url` in the user's browser (MCP Apps `ui/open-link`). False when the
   * host has no link support or declined: the card then shows the link itself. */
  openLink(url: string): Promise<boolean>;
  /** Display modes the host offers (MCP Apps `availableDisplayModes`); undefined when it does not say. */
  displayModes?(): string[] | undefined;
  /** The display mode the card is shown in now: 'inline' when the host does not say. */
  displayMode?(): string;
  /** Ask the host for a display mode. Resolves with the mode the host actually applied (which may
   * be the current one when it refuses or fails); never rejects and never assumes the request was granted. */
  requestDisplayMode?(mode: 'inline' | 'fullscreen' | 'pip'): Promise<string>;
  /** The display mode, or the modes on offer, changed. Called with the current mode. */
  onDisplayModeChange?(cb: (mode: string) => void): void;
  /** Host name/version, platform, display modes and container size from the host context. No user data. */
  hostInfo?(): HostInfo;
  /** frontier_stop_task from the card: only ever called from the user's click on Stop task.
   * True when the server accepted it. Never retried. */
  stopTask?(taskId: string): Promise<boolean>;
  /** frontier_add_files tool results: the card's "Add files" view for a task (new or existing). */
  onAddFiles?(cb: (a: AddFilesPayload) => void): void;
  /** frontier_request_upload (no `files`) from the card: one upload ticket for `taskId`. */
  uploadTicket?(taskId: string, instruction?: string): Promise<TicketResult>;
  /** Post `text` into the chat as the user (MCP Apps `ui/message`). False when the host cannot. */
  sendMessage?(text: string): Promise<boolean>;
}
