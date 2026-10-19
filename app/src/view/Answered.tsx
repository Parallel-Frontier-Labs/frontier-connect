import { useEffect, useRef } from 'preact/hooks';
import type { TaskPayload } from '../types';
import { ChosenDot, QueuedDot, TickIcon } from './icons';
import { currentIndex } from './Plan';

/** What the card shows once an answer is sent: the question with the choice locked in. */
export interface AnsweredItem {
  prompt: string;
  /** Options with the chosen ones marked; empty for free-text answers. */
  options: { label: string; chosen: boolean }[];
  /** A typed answer (text question, Other, or a form field summary line). */
  text?: string;
}
export interface Answered {
  askId: string;
  items: AnsweredItem[];
  /** The lead word of the status line: "Answered", "Skipped", "Not now", "Already answered". */
  label: string;
  /** Progress when it was sent (see progressKey). */
  progress: string;
}

/** `focus`: move focus here on mount (right after a send replaced the inputs, so focus is not lost). */
export function AnsweredView({ a, payload: p, focus = false }: { a: Answered; payload: TaskPayload; focus?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) box.current?.focus();
  }, []);
  const cur = currentIndex(p.plan);
  const where = p.plan.length && cur >= 0 ? ` with step ${cur + 1} of ${p.plan.length}` : '';
  return (
    <div class="fc-answered" ref={box} tabIndex={-1}>
      {a.items.length ? (
        <div class="fc-lockbox">
          {a.items.map((it, i) => (
            <div key={i} class="fc-lockq">
              {it.prompt ? <div class="fc-lockprompt">{it.prompt}</div> : null}
              {it.options.length ? (
                <ul class="fc-locklist" aria-label="Options (locked)">
                  {it.options.map((o, j) => (
                    <li key={j} class={o.chosen ? 'fc-lock fc-lock-on' : 'fc-lock'}>
                      {o.chosen ? <ChosenDot /> : <QueuedDot size={16} label={null} />}
                      {o.label}
                    </li>
                  ))}
                </ul>
              ) : null}
              {it.text ? (
                <div class="fc-lock fc-lock-on">
                  <ChosenDot />
                  <span class="fc-pre">{it.text}</span>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div class="fc-sent">
        <TickIcon />
        <span>
          <span class="fc-strong">{a.label}</span> · continuing{where}
        </span>
      </div>
    </div>
  );
}
