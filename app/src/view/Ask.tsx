import { useState } from 'preact/hooks';
import { own } from '../form';
import { QUESTION_KINDS, type OpenAsk, type Question } from '../types';
import type { AnsweredItem } from './Answered';
import { ArrowIcon, QuestionIcon } from './icons';
import { useSend, type SendProps } from './useSend';

interface Choice {
  opt?: string;
  opts: string[];
  other: boolean;
  otherText: string;
  text: string;
  confirm?: boolean;
}
const EMPTY: Choice = { opts: [], other: false, otherText: '', text: '' };

const kindOf = (q: Question): (typeof QUESTION_KINDS)[number] | null => QUESTION_KINDS.find((k) => k === q.kind) ?? null;

/** Everything the card can answer: each question has an id and a kind it knows. */
export const answerable = (qs: Question[]): boolean => qs.length > 0 && qs.every((q) => !!q.id && kindOf(q) !== null);

/** The Answer object for one question, or an error line when it still needs input. */
export function buildAnswer(q: Question, p: Choice): { answer?: Record<string, unknown>; error?: string } {
  const questionId = q.id!;
  const kind = kindOf(q)!;
  const other = p.otherText.trim();
  const blank =
    (kind === 'single_select' && !p.opt && !p.other) ||
    (kind === 'multi_select' && !p.opts.length && !(p.other && other)) ||
    (kind === 'confirm' && p.confirm === undefined) ||
    (kind === 'text' && !p.text.trim());
  if (blank) return q.optional ? { answer: { questionId, kind: 'defer' } } : { error: kind === 'text' ? 'Type an answer' : 'Choose an answer' };
  if (p.other && !other && kind !== 'multi_select') return { error: 'Type your answer' };
  if (kind === 'single_select') return { answer: p.other ? { questionId, kind, otherText: other } : { questionId, kind, optionId: p.opt } };
  if (kind === 'multi_select') return { answer: { questionId, kind, optionIds: p.opts, ...(p.other && other ? { otherText: other } : {}) } };
  if (kind === 'confirm') return { answer: { questionId, kind, value: p.confirm } };
  return { answer: { questionId, kind: 'text', text: p.text.trim() } };
}

function lockedItem(q: Question, p: Choice): AnsweredItem {
  const kind = kindOf(q);
  if (kind === 'confirm') {
    return {
      prompt: q.prompt ?? '',
      options: [
        { label: q.confirmLabel || 'Yes', chosen: p.confirm === true },
        { label: q.denyLabel || 'No', chosen: p.confirm === false },
      ],
    };
  }
  if (kind === 'text') return { prompt: q.prompt ?? '', options: [], text: p.text.trim() };
  const chosen = (id?: string) => (kind === 'multi_select' ? !!id && p.opts.includes(id) : !p.other && id === p.opt);
  return {
    prompt: q.prompt ?? '',
    options: (q.options ?? []).map((o) => ({ label: o.label ?? '', chosen: chosen(o.id) })),
    text: p.other && p.otherText.trim() ? p.otherText.trim() : undefined,
  };
}

/** A question from the task, answered in the card (or in the chat when the host can't send). */
export function QuestionAsk({ ask, canSend, send, onSent }: { ask: OpenAsk } & SendProps) {
  const qs = ask.questions ?? [];
  const live = canSend && answerable(qs);
  const [picks, setPicks] = useState<Record<string, Choice>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { busy, error, submit } = useSend({ send, onSent }, ask.ask_id ?? '');
  const pickOf = (q: Question, i: number): Choice => own(picks, q.id ?? `#${i}`) ?? EMPTY;
  const update = (q: Question, i: number, change: Partial<Choice>) => {
    const key = q.id ?? `#${i}`;
    setPicks({ ...picks, [key]: { ...pickOf(q, i), ...change } });
    if (own(errors, key)) setErrors({ ...errors, [key]: '' });
  };
  const onSubmit = (e: Event) => {
    e.preventDefault();
    if (!live || busy) return;
    const answers: Record<string, unknown>[] = [];
    const errs: Record<string, string> = {};
    qs.forEach((q, i) => {
      const r = buildAnswer(q, pickOf(q, i));
      if (r.error) errs[q.id!] = r.error;
      else answers.push(r.answer!);
    });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    void submit(answers, { items: qs.map((q, i) => lockedItem(q, pickOf(q, i))), label: 'Answered' });
  };
  const disabled = !live || busy;
  return (
    <form class="fc-askbox" aria-label="Frontier needs your answer" onSubmit={onSubmit} noValidate>
      <div class="fc-askhead">
        <QuestionIcon />
        <span>Frontier needs your answer</span>
      </div>
      {qs.map((q, i) => {
        const p = pickOf(q, i);
        const name = `q${i}`;
        const err = own(errors, q.id ?? '') || '';
        const kind = kindOf(q);
        const errId = `${name}-err`;
        return (
          <fieldset key={q.id ?? i} class="fc-qset" disabled={disabled} aria-describedby={err ? errId : undefined}>
            <legend class={i === 0 ? 'fc-legend' : 'fc-legend fc-legend-sm'}>{q.prompt || 'Frontier has a question'}</legend>
            {q.subPrompt ? <p class="fc-sub">{q.subPrompt}</p> : null}
            {kind === 'confirm' ? (
              [true, false].map((v) => (
                <label key={String(v)} class={p.confirm === v ? 'fc-opt fc-opt-on' : 'fc-opt'}>
                  <input type="radio" name={name} checked={p.confirm === v} onChange={() => update(q, i, { confirm: v })} />
                  <span>{v ? q.confirmLabel || 'Yes' : q.denyLabel || 'No'}</span>
                </label>
              ))
            ) : kind === 'single_select' || kind === 'multi_select' ? (
              <>
                {(q.options ?? []).map((o, j) => {
                  const multi = kind === 'multi_select';
                  const on = multi ? !!o.id && p.opts.includes(o.id) : !p.other && !!o.id && p.opt === o.id;
                  return (
                    <label key={o.id ?? j} class={on ? 'fc-opt fc-opt-on' : 'fc-opt'}>
                      <input
                        type={multi ? 'checkbox' : 'radio'}
                        name={name}
                        checked={on}
                        onChange={() =>
                          multi
                            ? update(q, i, { opts: on ? p.opts.filter((x) => x !== o.id) : [...p.opts, o.id!] })
                            : update(q, i, { opt: o.id, other: false })
                        }
                      />
                      <span>
                        {o.label}
                        {o.description ? <span class="fc-muted"> {o.description}</span> : null}
                      </span>
                    </label>
                  );
                })}
                {q.allowOther ? (
                  <div class={p.other ? 'fc-opt fc-opt-other fc-opt-on' : 'fc-opt fc-opt-other'}>
                    <input
                      id={`${name}-other`}
                      type={kind === 'multi_select' ? 'checkbox' : 'radio'}
                      name={name}
                      checked={p.other}
                      aria-label="Other answer"
                      onChange={() => update(q, i, kind === 'multi_select' ? { other: !p.other } : { other: true, opt: undefined })}
                    />
                    <label for={`${name}-other`} class="fc-other-l">Other…</label>
                    <input
                      class="fc-txt"
                      type="text"
                      aria-label="Describe another answer"
                      placeholder="Type your own answer"
                      maxLength={2000}
                      value={p.otherText}
                      onInput={(e) => update(q, i, { otherText: (e.target as HTMLInputElement).value, other: true, ...(kind === 'single_select' ? { opt: undefined } : {}) })}
                    />
                  </div>
                ) : null}
              </>
            ) : (
              <textarea
                class="fc-ctl fc-area"
                rows={2}
                aria-label={q.prompt || 'Your answer'}
                placeholder={q.placeholder || 'Type your answer'}
                maxLength={4000}
                value={p.text}
                onInput={(e) => update(q, i, { text: (e.target as HTMLTextAreaElement).value })}
              />
            )}
            {err ? <p id={errId} class="fc-err">{err}</p> : null}
          </fieldset>
        );
      })}
      {live ? (
        <div class="fc-actions">
          <button type="submit" class="fc-primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send answer'}
            {busy ? null : <ArrowIcon />}
          </button>
          <span class="fc-muted">Or reply in the chat</span>
        </div>
      ) : (
        <p class="fc-muted fc-fallback">Reply in the chat to answer.</p>
      )}
      {error ? <p class="fc-err" role="alert">{error}</p> : null}
    </form>
  );
}
