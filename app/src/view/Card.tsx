import { useRef, useState } from 'preact/hooks';
import type { AnswerOutcome, Answers } from '../bridge';
import type { Status, TaskPayload } from '../types';
import { AnsweredView, type Answered } from './Answered';
import { Done } from './Done';
import { Ended } from './Ended';
import { FilesAsk } from './FilesAsk';
import { Footer } from './Footer';
import { FormAsk } from './FormAsk';
import { Mark, Now } from './icons';
import { NoPlan } from './Sections';
import { PausedSteps, PlanProgress, progressKey } from './Plan';
import { QuestionAsk } from './Ask';

/** How the card answers: through the host's app tool call, when the host offers one. */
export interface AnswerApi {
  enabled: boolean;
  send(askId: string, answers: Answers): Promise<AnswerOutcome>;
}

const NO_ANSWERS: AnswerApi = { enabled: false, send: async () => ({ kind: 'failed', message: '' }) };

const PILL = new Map<Status, string>([
  ['starting', 'Starting'],
  ['running', 'Working'],
  ['waiting_for_answer', 'Needs your answer'],
  ['waiting_for_you', 'Waiting for you'],
  ['done', 'Done'],
  ['stopped', 'Stopped'],
  ['error', 'Failed'],
]);

function Pill({ status }: { status: Status }) {
  const label = PILL.get(status) ?? 'Starting';
  let mark = null;
  if (status === 'running' || status === 'starting') mark = <Now small label={null} />;
  else if (status === 'waiting_for_answer' || status === 'waiting_for_you') mark = <span class="fc-pill-dot" aria-hidden="true" />;
  else if (status === 'done') {
    mark = (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2.5 6.3l2.2 2.2 4.8-5" />
      </svg>
    );
  } else if (status === 'stopped') {
    mark = (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
      </svg>
    );
  } else if (status === 'error') {
    mark = (
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <path d="M6 3v3.6" />
        <circle cx="6" cy="9" r=".5" fill="currentColor" />
      </svg>
    );
  }
  return (
    <span class={`fc-pill fc-pill-${status}`}>
      {mark}
      {label}
    </span>
  );
}

export function Card({
  payload: p,
  theme = 'light',
  answer = NO_ANSWERS,
}: {
  payload: TaskPayload;
  theme?: 'light' | 'dark';
  answer?: AnswerApi;
}) {
  // The last answer sent from this card. It keeps the options locked ("Answered · continuing")
  // while the task picks it up, which the engine does asynchronously.
  const [answered, setAnswered] = useState<Answered | null>(null);
  const active = p.status === 'running' || p.status === 'starting';
  const waiting = p.status === 'waiting_for_answer' || p.status === 'waiting_for_you';
  const terminal = p.status === 'done' || p.status === 'stopped' || p.status === 'error';
  // A follow-up turn on the chat's task (frontier_continue_task) says so under the title.
  const followUp = typeof p.turn === 'number' && p.turn > 1;
  const ask = p.open_ask;
  const progress = progressKey(p);
  const lockedAsk = !!answered && !!ask && ask.ask_id === answered.askId;
  // After the ask closes, the note stays until the task moves on (a step or section changes).
  const showAnswered = !!answered && (lockedAsk || (active && !ask && answered.progress === progress));
  // Focus moves to the answered note only on the render right after a send.
  const focusNote = useRef(false);
  const onSent = (a: Omit<Answered, 'progress'>) => {
    focusNote.current = true;
    setAnswered({ ...a, progress });
  };
  const takeFocus = () => {
    const f = focusNote.current;
    focusNote.current = false;
    return f;
  };
  const canSend = answer.enabled && !!ask?.ask_id;
  const announcement = `Frontier task ${PILL.get(p.status) ?? 'Starting'}${showAnswered ? `. ${answered!.label}, continuing` : ''}.`;

  let body = null;
  if (terminal) {
    body = p.status === 'done' ? <Done payload={p} /> : <Ended payload={p} />;
  } else if (waiting && ask && !lockedAsk) {
    const send = (answers: Answers) => answer.send(ask.ask_id!, answers);
    const askView =
      ask.kind === 'form' ? (
        <FormAsk key={ask.ask_id} ask={ask} canSend={canSend} send={send} onSent={onSent} />
      ) : ask.kind === 'files' ? (
        <FilesAsk key={ask.ask_id} ask={ask} canSend={canSend} send={send} onSent={onSent} />
      ) : (
        <QuestionAsk key={ask.ask_id} ask={ask} canSend={canSend} send={send} onSent={onSent} />
      );
    body = ask.kind === 'form' ? askView : (
      <div class="fc-body">
        {askView}
        <PausedSteps payload={p} />
      </div>
    );
  } else if (waiting && showAnswered) {
    body = (
      <div class="fc-body fc-body-tight">
        <AnsweredView a={answered!} payload={p} focus={takeFocus()} />
      </div>
    );
  } else if (waiting) {
    body = (
      <div class="fc-body">
        <p class="fc-note">Frontier is waiting for you. Reply in the chat to carry on.</p>
        <PausedSteps payload={p} />
      </div>
    );
  } else {
    body = (
      <>
        {showAnswered ? (
          <div class="fc-body fc-body-tight fc-body-answered">
            <AnsweredView a={answered!} payload={p} focus={takeFocus()} />
          </div>
        ) : null}
        {p.plan.length ? <PlanProgress payload={p} /> : <NoPlan payload={p} />}
      </>
    );
  }

  return (
    <article class="fc-card" data-theme={theme} aria-label={`Frontier task: ${p.title || 'Frontier task'}`}>
      <header class="fc-head">
        <Mark />
        <div class="fc-heading">
          <div class="fc-title">{p.title || 'Frontier task'}</div>
          <div class="fc-org">
            {p.org ? <span class="fc-org-name">{p.org}</span> : 'Frontier'}
            {followUp ? ` · Follow-up · turn ${p.turn}` : p.org ? ' · Frontier' : null}
          </div>
        </div>
        <Pill status={p.status} />
      </header>
      {body}
      {terminal ? <Footer payload={p} /> : null}
      {/* One persistent live region: status changes and a sent answer are announced. */}
      <div class="fc-sr" aria-live="polite" aria-atomic="true">{announcement}</div>
    </article>
  );
}

