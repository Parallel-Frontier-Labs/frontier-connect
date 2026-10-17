import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { Card } from '../src/view/Card';
import type { TaskPayload } from '../src/types';

afterEach(cleanup);
const mk = (o: Partial<TaskPayload> = {}): TaskPayload => ({
  task_id: 't', status: 'running', title: 'Quarterly review', plan: [], sections: [], live: null, estimate: null,
  open_ask: null, deliverables: [], result: null, work_ms: 0, usage: null, events: [], cursor: 0, more: false, ...o,
});

describe('Card', () => {
  it('starting shows the placeholder', () => {
    const { getByText } = render(<Card payload={mk({ status: 'starting' })} />);
    getByText('Getting started…');
    getByText('Starting');
  });

  it('does not show the placeholder once live text exists', () => {
    const { getByText, queryByText } = render(<Card payload={mk({ status: 'starting', live: 'Opening the files…' })} />);
    getByText('Opening the files…');
    expect(queryByText('Getting started…')).toBeNull();
  });

  it('running shows sections, outcome, live phrase and eta', () => {
    const { getByText } = render(
      <Card payload={mk({
        sections: [{ id: 'a', title: 'Read statements', done: true, outcome: '3 files' }, { id: 'b', title: 'Compare', done: false, outcome: null }],
        live: 'Comparing allocations…', estimate: { eta_s: 240 },
        plan: [{ title: 'Draft', status: 'queued' }],
      })} />,
    );
    getByText('Read statements');
    getByText(/3 files/);
    getByText('Compare');
    getByText('Comparing allocations…');
    getByText('About 4 min left');
    getByText('Working');
    getByText('Draft');
  });

  it('waiting shows the question, options and the reply hint', () => {
    const { getByText } = render(
      <Card payload={mk({ status: 'waiting_for_answer', open_ask: { ask_id: 'ask_1', kind: 'question', questions: [{ prompt: 'Which allocation?', options: [{ label: 'Moderate' }] }] } })} />,
    );
    getByText('Which allocation?');
    getByText('Moderate');
    getByText('Reply in the chat to answer.');
    getByText('Waiting for your answer');
  });

  it('files and form asks show their hints', () => {
    const a = render(<Card payload={mk({ status: 'waiting_for_you', open_ask: { ask_id: null, kind: 'files', text: 'Need the IRA statement' } })} />);
    a.getByText('Need the IRA statement');
    a.getByText('Attach the files in the chat.');
    cleanup();
    const b = render(<Card payload={mk({ status: 'waiting_for_you', open_ask: { ask_id: null, kind: 'form', form: { title: 'Client details' } } })} />);
    b.getByText('Client details');
    b.getByText('Open Frontier to fill in this form.');
  });

  it('done shows summary, files, time and tokens', () => {
    const { getByText } = render(
      <Card payload={mk({
        status: 'done', work_ms: 65000, usage: { input_tokens: 10000, cached_input_tokens: 500, output_tokens: 2300 },
        result: { summary: 'Trim growth by 6%.', summary_type: 'markdown', takeaway: 'Rebalance now.' },
        deliverables: [{ name: 'review.pdf' }],
      })} />,
    );
    getByText('Trim growth by 6%.');
    getByText('Rebalance now.');
    getByText('review.pdf');
    getByText('1m 5s');
    getByText('12.3k tokens');
    getByText('Done');
  });

  it('error shows the error pill', () => {
    const { getByText } = render(<Card payload={mk({ status: 'error' })} />);
    getByText('Stopped with an error');
  });

  it('renders summary markup as text', () => {
    const { container } = render(
      <Card payload={mk({ status: 'done', result: { summary: '<img src=x onerror=alert(1)>', summary_type: 'markdown', takeaway: null } })} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('applies the theme', () => {
    const { container } = render(<Card payload={mk()} theme="dark" />);
    expect(container.querySelector('[data-theme="dark"]')).not.toBeNull();
  });
});
