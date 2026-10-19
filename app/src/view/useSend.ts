import { useRef, useState } from 'preact/hooks';
import type { AnswerOutcome, Answers } from '../bridge';
import type { Answered } from './Answered';

export const ALREADY_ANSWERED = 'Already answered.';

export interface SendProps {
  canSend: boolean;
  send: (answers: Answers) => Promise<AnswerOutcome>;
  onSent: (a: Omit<Answered, 'progress'>) => void;
}

/**
 * Optimistic send: the inputs lock as soon as the user sends. A refusal unlocks them with its
 * one-line reason, except "Already answered." which stays locked (the task has the answer).
 * Nothing is retried: a timeout or error is shown and the user decides.
 */
export function useSend({ send, onSent }: Pick<SendProps, 'send' | 'onSent'>, askId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const submit = async (answers: Answers, sent: Omit<Answered, 'progress' | 'askId'>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const out = await send(answers);
    if (out.kind === 'accepted') {
      onSent({ ...sent, askId });
      return;
    }
    if (out.kind === 'refused' && out.reason === ALREADY_ANSWERED) {
      onSent({ askId, items: [], label: 'Already answered' });
      return;
    }
    inFlight.current = false;
    setBusy(false);
    setError(out.kind === 'refused' ? out.reason : out.message);
  };
  return { busy, error, submit };
}
