import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnswerOutcome, Bridge } from '../src/bridge';
import { Root } from '../src/Root';
import type { TaskPayload } from '../src/types';

function rig(theme: 'light' | 'dark' = 'light', tools = false, answer: Bridge['answer'] = async () => ({ kind: 'accepted', payload: null })) {
  let onPayload: (p: TaskPayload) => void = () => {};
  let onReady: () => void = () => {};
  let onTheme: (t: 'light' | 'dark') => void = () => {};
  let onErr: (e: unknown) => void = () => {};
  let cur = theme;
  const bridge: Bridge = {
    onPayload: (cb) => (onPayload = cb),
    getTask: async () => null,
    theme: () => cur,
    onThemeChange: (cb) => (onTheme = cb),
    onConnectError: (cb) => (onErr = cb),
    canCallTools: () => tools,
    onReady: (cb) => (onReady = cb),
    answer: vi.fn(answer),
  };
  return {
    bridge,
    payload: (p: TaskPayload) => onPayload(p),
    theme: (t: 'light' | 'dark') => ((cur = t), onTheme(t)),
    fail: (e: unknown) => onErr(e),
    ready: () => onReady(),
  };
}

const done = {
  task_id: 't1', status: 'done', title: 'Quarterly review', plan: [], sections: [], live: null,
  estimate: null, open_ask: null, deliverables: [], result: null, work_ms: 0, usage: null,
  events: [], cursor: 1, more: false, view: null,
} as unknown as TaskPayload;

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

describe('Root', () => {
  it('updates data-theme when the host theme changes', () => {
    const r = rig('light');
    render(<Root makeBridge={() => r.bridge} />);
    expect(document.documentElement.dataset.theme).toBe('light');
    act(() => r.theme('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('shows a connect error instead of loading forever', () => {
    const r = rig();
    render(<Root makeBridge={() => r.bridge} />);
    expect(screen.getByText(/Loading the task/)).toBeTruthy();
    act(() => r.fail(new Error('no host')));
    expect(screen.getByText("Couldn't connect to the chat app. Reload the conversation.")).toBeTruthy();
    expect(screen.queryByText(/Loading the task/)).toBeNull();
  });

  it('keeps showing the card if a payload arrived before the error', () => {
    const r = rig();
    render(<Root makeBridge={() => r.bridge} />);
    act(() => r.payload(done));
    act(() => r.fail(new Error('late')));
    expect(screen.getByText('Quarterly review')).toBeTruthy();
  });

  it('renders at once from a payload handed over before mount effects ran', () => {
    const r = rig();
    let handed: ((p: TaskPayload) => void) | null = null;
    const bridge: Bridge = {
      ...r.bridge,
      // Like the host bridge: a result received before registration is replayed on registration.
      onPayload: (cb) => { handed = cb; cb(done); },
    };
    render(<Root makeBridge={() => bridge} />);
    expect(handed).not.toBeNull();
    expect(screen.getByText('Quarterly review')).toBeTruthy();
    expect(screen.queryByText(/Loading the task/)).toBeNull();
  });

  const waiting = {
    ...done, status: 'waiting_for_answer', view: null,
    open_ask: { ask_id: 'ask_1', kind: 'question', questions: [{ id: 'q', kind: 'confirm', prompt: 'Go ahead?' }] },
  } as unknown as TaskPayload;

  it('offers Send only once the host says it forwards app tool calls', () => {
    const r = rig('light', true);
    render(<Root makeBridge={() => r.bridge} />);
    act(() => r.payload(waiting));
    screen.getByText('Reply in the chat to answer.');
    act(() => r.ready());
    screen.getByRole('button', { name: 'Send answer' });
  });

  it('a host without app tool calls keeps the chat fallback after the handshake', () => {
    const r = rig('light', false);
    render(<Root makeBridge={() => r.bridge} />);
    act(() => r.payload(waiting));
    act(() => r.ready());
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull();
    screen.getByText('Reply in the chat to answer.');
  });

  it('sends the answer for this task and folds the returned payload in', async () => {
    const fresh = { ...waiting, status: 'running', open_ask: null, title: 'Carrying on', cursor: 9 } as unknown as TaskPayload;
    const r = rig('light', true, async (): Promise<AnswerOutcome> => ({ kind: 'accepted', payload: fresh }));
    render(<Root makeBridge={() => r.bridge} />);
    act(() => r.payload(waiting));
    act(() => r.ready());
    fireEvent.click(screen.getByLabelText('Yes'));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
    expect(r.bridge.answer).toHaveBeenCalledWith('t1', 'ask_1', [{ questionId: 'q', kind: 'confirm', value: true }]);
    screen.getByText('Carrying on');
    screen.getByText('Answered');
  });
});
