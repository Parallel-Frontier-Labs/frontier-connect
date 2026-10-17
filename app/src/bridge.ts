import type { TaskPayload } from './types';
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
}
