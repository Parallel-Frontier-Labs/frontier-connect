import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnswerOutcome } from '../src/bridge';
import { FilesAsk } from '../src/view/FilesAsk';
import { Card, type AnswerApi } from '../src/view/Card';
import { parsePayload, type OpenAsk, type TaskPayload } from '../src/types';

afterEach(cleanup);
const mk = (o: Partial<TaskPayload> = {}): TaskPayload => ({
  task_id: 't', status: 'waiting_for_answer', title: 'Plan summary', plan: [], sections: [], live: null, estimate: null,
  open_ask: null, deliverables: [], result: null, work_ms: 0, usage: null, events: [], cursor: 0, more: false, ...o,
});
const api = (impl: (askId: string, answers: unknown) => Promise<AnswerOutcome>) => {
  const send = vi.fn(impl);
  return { send, answer: { enabled: true, send } as AnswerApi };
};
const accepted = async (): Promise<AnswerOutcome> => ({ kind: 'accepted', payload: null });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const question: OpenAsk = {
  ask_id: 'ask_1', kind: 'question',
  questions: [{
    id: 'age', kind: 'single_select', prompt: 'Which retirement age?', allowOther: true,
    options: [{ id: 'a67', label: '67, as modelled' }, { id: 'a65', label: '65, as stated' }],
  }],
};
const plan = [
  { title: 'Read', status: 'done' }, { title: 'Check', status: 'in_progress' }, { title: 'Write', status: 'queued' },
] as TaskPayload['plan'];

describe('question', () => {
  it('lets the user pick an option and send it; the card locks and says Answered · continuing', async () => {
    const { send, answer } = api(accepted);
    const p = mk({ open_ask: question, plan });
    const { getByLabelText, getByRole, getByText, rerender, container } = render(<Card payload={p} answer={answer} />);
    getByText('Frontier needs your answer');
    getByText('1 of 3');
    getByRole('img', { name: 'Paused, waiting for you' });
    fireEvent.click(getByLabelText('67, as modelled'));
    fireEvent.click(getByRole('button', { name: 'Send answer' }));
    await flush();
    expect(send).toHaveBeenCalledWith('ask_1', [{ questionId: 'age', kind: 'single_select', optionId: 'a67' }]);
    getByText('Answered');
    getByText(/continuing with step 2 of 3/);
    expect(container.querySelector('.fc-lock-on')!.textContent).toBe('67, as modelled');
    expect(container.querySelector('input')).toBeNull();
    // The engine picks the answer up asynchronously: the same ask is still open on the next poll.
    rerender(<Card payload={{ ...p }} answer={answer} />);
    getByText('Answered');
    expect(container.querySelector('input')).toBeNull();
    // Then the task carries on: the note stays until the step changes.
    rerender(<Card payload={mk({ status: 'running', plan })} answer={answer} />);
    getByText('Answered');
    rerender(<Card payload={mk({ status: 'running', plan: plan.map((s, i) => (i === 1 ? { ...s, status: 'done' } : s)) })} answer={answer} />);
    expect(container.textContent).not.toContain('Answered');
  });

  it('sends Other as free text', async () => {
    const { send, answer } = api(accepted);
    const { getByLabelText, getByRole } = render(<Card payload={mk({ open_ask: question })} answer={answer} />);
    fireEvent.input(getByLabelText('Describe another answer'), { target: { value: ' 66, phased ' } });
    fireEvent.click(getByRole('button', { name: 'Send answer' }));
    await flush();
    expect(send).toHaveBeenCalledWith('ask_1', [{ questionId: 'age', kind: 'single_select', otherText: '66, phased' }]);
  });

  it('asks for a choice before sending', async () => {
    const { send, answer } = api(accepted);
    const { getByRole, getByText } = render(<Card payload={mk({ open_ask: question })} answer={answer} />);
    fireEvent.click(getByRole('button', { name: 'Send answer' }));
    await flush();
    getByText('Choose an answer');
    expect(send).not.toHaveBeenCalled();
  });

  it('a refusal shows its reason and unlocks the options', async () => {
    const reason = "Frontier declined this request: it looks like an attempt to override or reveal Frontier's instructions.";
    const { send, answer } = api(async () => ({ kind: 'refused', reason, payload: null }));
    const { getByLabelText, getByRole, getByText } = render(<Card payload={mk({ open_ask: question })} answer={answer} />);
    fireEvent.click(getByLabelText('65, as stated'));
    fireEvent.click(getByRole('button', { name: 'Send answer' }));
    await flush();
    getByText(reason);
    expect(getByLabelText('65, as stated').matches(':disabled')).toBe(false);
    expect((getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(getByRole('button', { name: 'Send answer' }));
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('"Already answered." keeps the card locked', async () => {
    const { answer } = api(async () => ({ kind: 'refused', reason: 'Already answered.', payload: null }));
    const { getByLabelText, getByRole, getByText, container } = render(<Card payload={mk({ open_ask: question })} answer={answer} />);
    fireEvent.click(getByLabelText('65, as stated'));
    fireEvent.click(getByRole('button', { name: 'Send answer' }));
    await flush();
    getByText('Already answered');
    expect(container.querySelector('input')).toBeNull();
  });

  it('locks while sending and never sends twice', async () => {
    let resolve: (o: AnswerOutcome) => void = () => {};
    const { send, answer } = api(() => new Promise((r) => (resolve = r)));
    const { getByLabelText, getByRole } = render(<Card payload={mk({ open_ask: question })} answer={answer} />);
    fireEvent.click(getByLabelText('65, as stated'));
    fireEvent.click(getByRole('button', { name: 'Send answer' }));
    await flush();
    const btn = getByRole('button', { name: 'Sending…' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(getByLabelText('65, as stated').matches(':disabled')).toBe(true);
    fireEvent.submit(btn.closest('form')!);
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ kind: 'accepted', payload: null }));
  });

  it('a send failure shows the message and unlocks', async () => {
    const { answer } = api(async () => ({ kind: 'failed', message: "Couldn't send your answer. Try again, or reply in the chat." }));
    const { getByLabelText, getByRole, getByText } = render(<Card payload={mk({ open_ask: question })} answer={answer} />);
    fireEvent.click(getByLabelText('65, as stated'));
    fireEvent.click(getByRole('button', { name: 'Send answer' }));
    await flush();
    getByText("Couldn't send your answer. Try again, or reply in the chat.");
    getByRole('button', { name: 'Send answer' });
  });

  it('multi-select, confirm, text and optional questions build the right answers', async () => {
    const { send, answer } = api(accepted);
    const ask: OpenAsk = {
      ask_id: 'ask_2', kind: 'question',
      questions: [
        { id: 'm', kind: 'multi_select', prompt: 'Which accounts?', allowOther: true, options: [{ id: 'ira', label: 'IRA' }, { id: 'k', label: '401k' }] },
        { id: 'c', kind: 'confirm', prompt: 'Include the spouse?', confirmLabel: 'Include', denyLabel: 'Leave out' },
        { id: 'x', kind: 'text', prompt: 'Anything else?', placeholder: 'Notes' },
        { id: 'o', kind: 'text', prompt: 'Optional note', optional: true },
      ],
    };
    const { getByLabelText, getByRole, getByPlaceholderText, getAllByLabelText } = render(<Card payload={mk({ open_ask: ask })} answer={answer} />);
    fireEvent.click(getByLabelText('IRA'));
    fireEvent.click(getByLabelText('401k'));
    fireEvent.input(getAllByLabelText('Describe another answer')[0]!, { target: { value: 'HSA' } });
    fireEvent.click(getByLabelText('Leave out'));
    fireEvent.input(getByPlaceholderText('Notes'), { target: { value: 'Use 2025 figures' } });
    fireEvent.click(getByRole('button', { name: 'Send answer' }));
    await flush();
    expect(send).toHaveBeenCalledWith('ask_2', [
      { questionId: 'm', kind: 'multi_select', optionIds: ['ira', 'k'], otherText: 'HSA' },
      { questionId: 'c', kind: 'confirm', value: false },
      { questionId: 'x', kind: 'text', text: 'Use 2025 figures' },
      { questionId: 'o', kind: 'defer' },
    ]);
  });

  it('without app tool calls the card shows the question and says to reply in the chat', () => {
    const { getByText, queryByRole, getByLabelText } = render(<Card payload={mk({ open_ask: question })} />);
    getByText('Which retirement age?');
    getByText('Reply in the chat to answer.');
    expect(queryByRole('button', { name: 'Send answer' })).toBeNull();
    expect(getByLabelText('67, as modelled').matches(':disabled')).toBe(true);
  });

  it('an ask the digest does not vouch for (no ask_id) cannot be answered from the card', () => {
    const { answer } = api(accepted);
    const { getByText, queryByRole } = render(<Card payload={mk({ open_ask: { ...question, ask_id: null } })} answer={answer} />);
    getByText('Reply in the chat to answer.');
    expect(queryByRole('button', { name: 'Send answer' })).toBeNull();
  });

  it('a question kind the card does not know falls back to the chat', () => {
    const { answer } = api(accepted);
    const ask: OpenAsk = { ask_id: 'ask_3', kind: 'question', questions: [{ id: 'q', kind: 'mystery', prompt: 'Pick' }] };
    const { getByText } = render(<Card payload={mk({ open_ask: ask })} answer={answer} />);
    getByText('Reply in the chat to answer.');
  });
});

describe('files needed', () => {
  const files: OpenAsk = { ask_id: 'ask_f', kind: 'files', text: 'The plan refers to an insurance illustration that was not attached.' };

  it('shows the request, says to attach it in the chat, and Skip sends a plain no', async () => {
    const { send, answer } = api(accepted);
    const { getByText, getByRole } = render(<Card payload={mk({ status: 'waiting_for_you', open_ask: files })} answer={answer} />);
    getByText('Frontier needs a file');
    getByText(files.text!);
    getByText('or attach it in the chat');
    fireEvent.click(getByRole('button', { name: 'Skip' }));
    await flush();
    expect(send).toHaveBeenCalledWith('ask_f', [{ questionId: 'folder', kind: 'confirm', value: false }]);
    getByText('Skipped');
  });

  it('without app tool calls there is no Skip', () => {
    const { getByText, queryByRole } = render(<Card payload={mk({ status: 'waiting_for_you', open_ask: files })} />);
    getByText('Attach it in the chat.');
    expect(queryByRole('button', { name: 'Skip' })).toBeNull();
  });
});

describe('form', () => {
  const form: OpenAsk = {
    ask_id: 'ask_form', kind: 'form',
    form: {
      title: 'Review meeting details', description: 'For the plan summary.', allowDefer: true,
      sections: [
        {
          id: 's1', title: 'Meeting', description: 'When and how.',
          fields: [
            { id: 'date', kind: 'date', label: 'Meeting date', required: true, options: [] },
            { id: 'who', kind: 'multi_select', label: 'Attendees', options: [{ id: 'sam', label: 'Sam' }, { id: 'kim', label: 'Kimberly' }], default: ['sam'] },
            { id: 'fmt', kind: 'radio', label: 'Format', options: [{ id: 'in', label: 'In person' }, { id: 'vid', label: 'Video' }] },
          ],
        },
        {
          id: 's2', title: 'Assumptions',
          fields: [
            { id: 'age', kind: 'number', label: 'Retirement age', required: true, min: 55, max: 75, unit: 'years', default: 67, help: 'Between 55 and 75.', options: [] },
            { id: 'ltc', kind: 'toggle', label: 'Include long-term care?', onLabel: 'Yes', offLabel: 'No', options: [] },
            { id: 'budget', kind: 'number', label: 'LTC budget', required: true, visibleWhen: { field: 'ltc', truthy: true }, options: [] },
            { id: 'notes', kind: 'long_text', label: 'Notes', placeholder: 'Anything to stress', options: [] },
          ],
        },
      ],
    },
  };

  it('renders sections and fields, hides dependent fields until their condition holds', () => {
    const { answer } = api(accepted);
    const { getByText, queryByLabelText, getByRole, getByLabelText } = render(<Card payload={mk({ status: 'waiting_for_you', open_ask: form })} answer={answer} />);
    getByText('Review meeting details');
    getByText('Meeting');
    getByText('When and how.');
    getByText('Between 55 and 75.');
    expect((getByLabelText('Sam') as HTMLInputElement).checked).toBe(true);
    expect(queryByLabelText(/LTC budget/)).toBeNull();
    fireEvent.click(getByRole('switch'));
    getByLabelText(/LTC budget/);
  });

  it('validates required and range inline, counts what needs attention, then submits visible values only', async () => {
    const { send, answer } = api(accepted);
    const { getByRole, getByText, getByLabelText, getAllByText, queryByText } = render(<Card payload={mk({ status: 'waiting_for_you', open_ask: form })} answer={answer} />);
    fireEvent.input(getByLabelText(/Retirement age/), { target: { value: '90' } });
    fireEvent.click(getByRole('button', { name: 'Submit' }));
    await flush();
    expect(send).not.toHaveBeenCalled();
    getByText('2 fields need attention');
    getAllByText('Required');
    getByText('Maximum 75');
    expect(getByLabelText(/Meeting date/).getAttribute('aria-invalid')).toBe('true');
    fireEvent.input(getByLabelText(/Meeting date/), { target: { value: '2026-11-03' } });
    fireEvent.input(getByLabelText(/Retirement age/), { target: { value: '66' } });
    expect(queryByText('2 fields need attention')).toBeNull();
    fireEvent.click(getByLabelText('Video'));
    fireEvent.click(getByRole('button', { name: 'Submit' }));
    await flush();
    expect(send).toHaveBeenCalledWith('ask_form', { values: { date: '2026-11-03', who: ['sam'], fmt: 'vid', age: 66, ltc: false } });
    getByText('Submitted');
  });

  it('a dependent required field blocks submit only while it is visible', async () => {
    const { send, answer } = api(accepted);
    const { getByRole, getByLabelText, getByText } = render(<Card payload={mk({ status: 'waiting_for_you', open_ask: form })} answer={answer} />);
    fireEvent.input(getByLabelText(/Meeting date/), { target: { value: '2026-11-03' } });
    fireEvent.click(getByRole('switch'));
    fireEvent.click(getByRole('button', { name: 'Submit' }));
    await flush();
    getByText('1 field needs attention');
    fireEvent.input(getByLabelText(/LTC budget/), { target: { value: '400' } });
    fireEvent.click(getByRole('button', { name: 'Submit' }));
    await flush();
    expect(send).toHaveBeenCalledWith('ask_form', { values: { date: '2026-11-03', who: ['sam'], age: 67, ltc: true, budget: 400 } });
  });

  it('Not now defers when the form allows it', async () => {
    const { send, answer } = api(accepted);
    const { getByRole, getByText } = render(<Card payload={mk({ status: 'waiting_for_you', open_ask: form })} answer={answer} />);
    fireEvent.click(getByRole('button', { name: 'Not now' }));
    await flush();
    expect(send).toHaveBeenCalledWith('ask_form', { deferred: true });
    getByText('Not now');
  });

  it('no Not now when deferring is not allowed', () => {
    const { answer } = api(accepted);
    const strict = { ...form, form: { ...form.form!, allowDefer: false } };
    const { queryByRole } = render(<Card payload={mk({ status: 'waiting_for_you', open_ask: strict })} answer={answer} />);
    expect(queryByRole('button', { name: 'Not now' })).toBeNull();
  });

  it('a refused form keeps the values and shows the reason', async () => {
    const { answer } = api(async () => ({ kind: 'refused', reason: 'This question is no longer open.', payload: null }));
    const { getByRole, getByLabelText, getByText } = render(<Card payload={mk({ status: 'waiting_for_you', open_ask: form })} answer={answer} />);
    fireEvent.input(getByLabelText(/Meeting date/), { target: { value: '2026-11-03' } });
    fireEvent.click(getByRole('button', { name: 'Submit' }));
    await flush();
    getByText('This question is no longer open.');
    expect((getByLabelText(/Meeting date/) as HTMLInputElement).value).toBe('2026-11-03');
  });

  it('without app tool calls the form is read-only with a reply-in-chat line', () => {
    const { getByText, queryByRole, getByLabelText } = render(<Card payload={mk({ status: 'waiting_for_you', open_ask: form })} />);
    getByText('Reply in the chat with the details.');
    expect(queryByRole('button', { name: 'Submit' })).toBeNull();
    expect((getByLabelText(/Meeting date/) as HTMLInputElement).disabled).toBe(true);
  });

  it('a pattern in the payload is ignored: the card never runs task-supplied regexes', async () => {
    const { send, answer } = api(accepted);
    const raw = { task_id: 't', status: 'waiting_for_you', open_ask: { ask_id: 'ask_p', kind: 'form', form: { title: 'IDs', sections: [{ id: 's', fields: [
      { id: 'zip', kind: 'short_text', label: 'ZIP', pattern: '^(a+)+$', required: true },
    ] }] } } };
    const p = parsePayload(raw)!;
    expect(p.open_ask!.form!.sections[0]!.fields[0]).not.toHaveProperty('pattern');
    const { getByRole, getByLabelText, queryByText } = render(<Card payload={p} answer={answer} />);
    fireEvent.input(getByLabelText(/ZIP/), { target: { value: 'aaaaaaaaaaaaaaaaaaaaaaaaa!' } });
    fireEvent.click(getByRole('button', { name: 'Submit' }));
    await flush();
    expect(queryByText('Invalid format')).toBeNull();
    expect(send).toHaveBeenCalledWith('ask_p', { values: { zip: 'aaaaaaaaaaaaaaaaaaaaaaaaa!' } });
  });

  const dated = (field: Record<string, unknown>) => parsePayload(parsePayload({
    task_id: 't', status: 'waiting_for_you',
    open_ask: { ask_id: 'ask_d', kind: 'form', form: { title: 'When', sections: [{ id: 's', fields: [{ id: 'd', kind: 'date', label: 'Day', required: true, ...field }] }] } },
  }))!;

  it('date bounds survive both parse passes, reach the input and are validated on submit', async () => {
    const { send, answer } = api(accepted);
    const p = dated({ min: '2026-10-01', max: '2026-12-31' });
    const { getByLabelText, getByRole, getByText, queryByText } = render(<Card payload={p} answer={answer} />);
    const el = getByLabelText(/Day/);
    expect(el.getAttribute('min')).toBe('2026-10-01');
    expect(el.getAttribute('max')).toBe('2026-12-31');
    fireEvent.input(el, { target: { value: '2026-09-30' } });
    fireEvent.click(getByRole('button', { name: 'Submit' }));
    await flush();
    getByText('On or after 2026-10-01');
    expect(el.getAttribute('aria-invalid')).toBe('true');
    fireEvent.input(el, { target: { value: '2027-01-01' } });
    getByText('On or before 2026-12-31');
    expect(send).not.toHaveBeenCalled();
    fireEvent.input(el, { target: { value: '2026-11-03' } });
    expect(queryByText(/On or (after|before)/)).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Submit' }));
    await flush();
    expect(send).toHaveBeenCalledWith('ask_d', { values: { d: '2026-11-03' } });
  });

  it('malformed date bounds are dropped and do not block a submit; a malformed value does', async () => {
    const { send, answer } = api(accepted);
    const p = dated({ min: '2026-13-01', max: '01/12/2026', default: '2026-02-30' });
    const f = p.open_ask!.form!.sections[0]!.fields[0]!;
    expect([f.minDate, f.maxDate]).toEqual([undefined, undefined]);
    const { getByLabelText, getByRole, getByText } = render(<Card payload={p} answer={answer} />);
    expect(getByLabelText(/Day/).getAttribute('min')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Submit' }));
    await flush();
    getByText('Enter a valid date');
    fireEvent.input(getByLabelText(/Day/), { target: { value: '1999-01-01' } });
    fireEvent.click(getByRole('button', { name: 'Submit' }));
    await flush();
    expect(send).toHaveBeenCalledWith('ask_d', { values: { d: '1999-01-01' } });
  });

  it('field ids like toString and valueOf never read Object.prototype', async () => {
    const { send, answer } = api(accepted);
    const f: OpenAsk = { ask_id: 'ask_o', kind: 'form', form: { title: 'Odd ids', sections: [{ id: 's', fields: [
      { id: 'toString', kind: 'short_text', label: 'Name', required: true, options: [] },
      { id: 'valueOf', kind: 'radio', label: 'Pick', allowOther: true, options: [{ id: 'a', label: 'A' }] },
      { id: 'hasOwnProperty', kind: 'short_text', label: 'Shown when', visibleWhen: { field: 'toString', truthy: true }, options: [] },
    ] }] } };
    const { getByRole, getByText, queryByLabelText, getByLabelText } = render(<Card payload={mk({ open_ask: f })} answer={answer} />);
    expect(queryByLabelText(/Shown when/)).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Submit' }));
    await flush();
    getByText('1 field needs attention');
    expect(send).not.toHaveBeenCalled();
    fireEvent.input(getByLabelText(/Name/), { target: { value: 'Ada' } });
    getByLabelText(/Shown when/);
    fireEvent.click(getByRole('button', { name: 'Submit' }));
    await flush();
    expect(send).toHaveBeenCalledWith('ask_o', { values: { toString: 'Ada' } });
  });
});

describe('announcements and focus', () => {
  it('a persistent live region announces status changes, and focus moves to the answered note after a send', async () => {
    const { answer } = api(accepted);
    const p = mk({ open_ask: question });
    const { container, getByLabelText, getByRole, rerender } = render(<Card payload={p} answer={answer} />);
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe('Frontier task Needs your answer.');
    fireEvent.click(getByLabelText('65, as stated'));
    getByRole('button', { name: 'Send answer' }).focus();
    fireEvent.click(getByRole('button', { name: 'Send answer' }));
    await flush();
    expect(container.querySelector('[aria-live="polite"]')).toBe(live);
    expect(live.textContent).toBe('Frontier task Needs your answer. Answered, continuing.');
    expect(document.activeElement).toBe(container.querySelector('.fc-answered'));
    rerender(<Card payload={mk({ status: 'done' })} answer={answer} />);
    expect(container.querySelector('[aria-live="polite"]')).toBe(live);
    expect(live.textContent).toBe('Frontier task Done.');
  });
});

describe('files ask uploads', () => {
  it('lets the user add the files Frontier asked for, then tells the chat', async () => {
    const tell = vi.fn(async (_t: string) => true);
    const upload = { enabled: true, send: vi.fn(async (_t: string, files: any[]) => ({ sent: files.map((f) => f.path), failed: [], error: null })), tell };
    render(<FilesAsk ask={{ ask_id: 'a1', kind: 'files', text: 'Upload the 2023 statements' }} taskId="task-1" canSend send={vi.fn()} onSent={() => {}} upload={upload} />);
    const input = document.querySelector<HTMLInputElement>('input[multiple]:not([webkitdirectory])')!;
    Object.defineProperty(input, 'files', { value: [new File(['x'], '2023.pdf')], configurable: true });
    fireEvent.change(input);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to Frontier' })); });
    await flush();
    expect(tell).toHaveBeenCalledTimes(1);
    expect(tell).toHaveBeenCalledWith('I added the file Frontier asked for (2023.pdf) to task task-1. Call frontier_continue_task for task-1 (if that tool isn\'t loaded yet, look it up by that exact name).');
    expect(screen.getByRole('status').textContent).toContain('Sent');
    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy();
  });
});
