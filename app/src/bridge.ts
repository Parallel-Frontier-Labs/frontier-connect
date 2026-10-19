import type { TaskPayload } from './types';

/** The answer value frontier_answer takes: a question's Answer list or a form submission. */
export type Answers = Record<string, unknown>[] | { values: Record<string, unknown> } | { deferred: true };

/** What came of a card answer. `payload` is the fresh task state the tool returns, when it parsed. */
export type AnswerOutcome =
  | { kind: 'accepted'; payload: TaskPayload | null }
  | { kind: 'refused'; reason: string; payload: TaskPayload | null }
  | { kind: 'failed'; message: string };

export interface Bridge {
  /** Every tool result the host shows this card for (start_task, get_task, wait_task). */
  onPayload(cb: (p: TaskPayload) => void): void;
  /** frontier_get_task through the host (runs under the user's OAuth grant). */
  getTask(taskId: string, after: number): Promise<TaskPayload | null>;
  theme(): 'light' | 'dark';
  /** The host changed its theme (light/dark toggle) while the card is open. */
  onThemeChange(cb: (t: 'light' | 'dark') => void): void;
  /** The host handshake failed (not inside a host, or it refused). Fires at most once, even if registered late. */
  onConnectError(cb: (e: unknown) => void): void;
  /** True once the host said it forwards the card's own tool calls (answers from the card). */
  canCallTools(): boolean;
  /** The handshake finished (capabilities known). Fires at most once, even if registered late. */
  onReady(cb: () => void): void;
  /** frontier_answer through the host. Never retried: a timeout or error is reported as failed. */
  answer(taskId: string, askId: string, answers: Answers): Promise<AnswerOutcome>;
}
