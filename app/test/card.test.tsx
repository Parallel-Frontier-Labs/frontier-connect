import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { Card } from '../src/view/Card';
import { parsePayload, type TaskPayload } from '../src/types';

afterEach(cleanup);
const mk = (o: Partial<TaskPayload> = {}): TaskPayload => ({
  task_id: 't', status: 'running', title: 'Quarterly review', plan: [], sections: [], live: null, estimate: null,
  open_ask: null, deliverables: [], result: null, work_ms: 0, usage: null, events: [], cursor: 0, more: false, ...o,
});
const steps = (...s: ('d' | 'p' | 'q')[]) =>
  s.map((x, i) => ({ title: `Step ${i + 1}`, status: x === 'd' ? 'done' : x === 'p' ? 'in_progress' : 'queued' }) as const);

describe('header', () => {
  it('shows the mark, title, organization and the status pill', () => {
    const { getByText, getByRole, container } = render(<Card payload={mk({ org: 'Acme Wealth' })} />);
    getByRole('img', { name: 'Frontier' });
    getByText('Quarterly review');
    expect(getByText('Acme Wealth').closest('header')).not.toBeNull();
    expect(container.querySelector('.fc-org')!.textContent).toBe('Acme Wealth · Frontier');
    expect(container.querySelector('.fc-pill')!.textContent).toBe('Working');
  });

  it('without an organization the line says Frontier only', () => {
    const { container } = render(<Card payload={mk()} />);
    expect(container.querySelector('.fc-org-name')).toBeNull();
    expect(container.querySelector('.fc-org')!.textContent).toBe('Frontier');
  });

  it.each([
    ['starting', 'Starting'], ['running', 'Working'], ['waiting_for_answer', 'Needs your answer'],
    ['waiting_for_you', 'Waiting for you'], ['done', 'Done'], ['stopped', 'Stopped'], ['error', 'Failed'],
  ] as const)('%s pill reads %s', (status, label) => {
    const { container } = render(<Card payload={mk({ status })} />);
    expect(container.querySelector('.fc-pill')!.textContent).toBe(label);
    expect(container.querySelector('.fc-pill')!.className).toBe(`fc-pill fc-pill-${status}`);
  });

  it('applies the theme', () => {
    const { container } = render(<Card payload={mk()} theme="dark" />);
    expect(container.querySelector('.fc-card')!.getAttribute('data-theme')).toBe('dark');
  });

  it('a follow-up turn shows "Follow-up · turn N" in the header line', () => {
    const { container } = render(<Card payload={mk({ org: 'Halcyon North', turn: 2 })} />);
    expect(container.querySelector('.fc-org')!.textContent).toBe('Halcyon North · Follow-up · turn 2');
    cleanup();
    const { container: bare } = render(<Card payload={mk({ turn: 3 })} />);
    expect(bare.querySelector('.fc-org')!.textContent).toBe('Frontier · Follow-up · turn 3');
    cleanup();
    const { container: first } = render(<Card payload={mk({ org: 'Halcyon North', turn: 1 })} />);
    expect(first.querySelector('.fc-org')!.textContent).toBe('Halcyon North · Frontier');
  });

  it('turn is a finite integer >= 1, anything else is 1', () => {
    const base = { task_id: 't', status: 'running' };
    expect(parsePayload(base)!.turn).toBe(1);
    expect(parsePayload({ ...base, turn: 4 })!.turn).toBe(4);
    for (const bad of [0, -2, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null, true, { n: 2 }]) {
      expect(parsePayload({ ...base, turn: bad })!.turn).toBe(1);
    }
  });

  it('organization is a capped plain string, anything else is dropped', () => {
    const base = { task_id: 't', status: 'running' };
    expect(parsePayload({ ...base, org: 'x'.repeat(200) })!.org).toHaveLength(80);
    expect(parsePayload({ ...base, org: { a: 1 } })!.org).toBeNull();
    expect(parsePayload({ ...base, org: '' })!.org).toBeNull();
    const { container } = render(<Card payload={parsePayload({ ...base, org: '<img src=x onerror=alert(1)>' })!} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.fc-org-name')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('running with a plan', () => {
  it('shows the meter, segments, eta and the current step panel with its live line', () => {
    const { getByText, container, getByRole } = render(
      <Card payload={mk({ plan: steps('d', 'd', 'p', 'q', 'q'), live: 'Reading pages 31-52…', estimate: { eta_s: 360 } })} />,
    );
    expect(container.querySelector('.fc-meter-count')!.textContent).toBe('2 of 5 steps done');
    getByText('About 6 min left');
    expect(container.querySelectorAll('.fc-seg').length).toBe(5);
    expect(container.querySelectorAll('.fc-seg-done').length).toBe(2);
    expect(container.querySelectorAll('.fc-seg-in_progress .fc-seg-run').length).toBe(1);
    const cur = container.querySelector('[aria-current="step"]')!;
    expect(cur.textContent).toContain('Step 3');
    expect(cur.textContent).toContain('Reading pages 31-52…');
    getByRole('img', { name: 'In progress' });
    expect(container.querySelectorAll('[aria-label="Done"]').length).toBe(2);
    expect(container.querySelectorAll('[aria-label="Queued"]').length).toBe(2);
  });

  it('a long plan keeps first, current and last, folding the rest until expanded', () => {
    const { getByRole, queryByText, getByText, container } = render(
      <Card payload={mk({ plan: steps('d', 'd', 'd', 'p', 'q', 'q', 'q', 'q', 'q') })} />,
    );
    getByText('Step 1');
    getByText('Step 4');
    getByText('Step 9');
    expect(queryByText('Step 2')).toBeNull();
    expect(queryByText('Step 6')).toBeNull();
    expect(container.querySelector('.fc-meter-count')!.textContent).toBe('3 of 9 steps done');
    fireEvent.click(getByRole('button', { name: '2 more done' }));
    getByText('Step 2');
    getByText('Step 3');
    fireEvent.click(getByRole('button', { name: '4 more queued' }));
    for (const n of [5, 6, 7, 8]) getByText(`Step ${n}`);
  });

  it('a gap of one step is shown, not folded', () => {
    const { getByText, queryByRole } = render(<Card payload={mk({ plan: steps('d', 'p', 'q', 'q', 'q', 'q', 'q', 'q') })} />);
    getByText('Step 1');
    getByText('Step 2');
    expect(queryByRole('button', { name: /more done/ })).toBeNull();
    expect(queryByRole('button', { name: '5 more queued' })).not.toBeNull();
  });
});

describe('running without a plan', () => {
  it('shows the now block, done-so-far sections and the latest three activity lines, newest first', () => {
    const events = [
      { seq: 1, kind: 'narration', text: 'Opened the plan' },
      { seq: 2, kind: 'activity', text: 'Read pages 1-20' },
      { seq: 3, kind: 'section', text: 'ignored' },
      { seq: 4, kind: 'narration', text: 'Read pages 46-52' },
      { seq: 5, kind: 'activity', text: 'Started Summary.md' },
    ];
    const { getByText, container, queryByText } = render(
      <Card payload={mk({
        sections: [{ id: 'a', title: 'Read the plan', done: true, outcome: 'all 52 pages' }, { id: 'b', title: 'Writing the summary', done: false, outcome: null }],
        live: 'Drafting the executive summary…', estimate: { eta_s: 120 }, events,
      })} />,
    );
    expect(container.querySelector('.fc-nowtitle')!.textContent).toBe('Writing the summary');
    getByText('Drafting the executive summary…');
    getByText('About 2 min left');
    expect(container.querySelector('.fc-track .fc-runner')).not.toBeNull();
    getByText('Done so far');
    getByText(/all 52 pages/);
    const ev = Array.from(container.querySelectorAll('.fc-ev')).map((e) => e.textContent);
    expect(ev).toEqual(['›Started Summary.md', '›Read pages 46-52', '›Read pages 1-20']);
    expect(queryByText('Opened the plan')).toBeNull();
    expect(container.querySelector('.fc-ev-new')!.textContent).toContain('Started Summary.md');
  });

  it('starting with nothing yet says it is getting started', () => {
    const { getByText } = render(<Card payload={mk({ status: 'starting' })} />);
    getByText('Getting started');
    getByText('Setting up the task…');
  });
});

describe('done', () => {
  const files = [
    { name: 'Summary.md', path: 'Review/Summary.md' },
    { name: 'Letter.docx', path: 'Review/Letter.docx' },
    { name: 'Cash flow.xlsx', path: 'Review/Appendix/Cash flow.xlsx' },
    { name: 'raw.csv', path: 'Review/notes/deep/raw.csv' },
  ];

  it('shows takeaway, summary, files, steps, time and total tokens', () => {
    const { getByText, container } = render(
      <Card payload={mk({
        status: 'done', work_ms: 117000, usage: { input_tokens: 10000, cached_input_tokens: 500, output_tokens: 2300, total_tokens: 354200 },
        result: { summary: 'Plan shows **no shortfall**.', summary_type: 'markdown', takeaway: 'No shortfall, three gaps.' },
        plan: steps('d', 'd', 'd'), deliverables: files,
      })} />,
    );
    expect(container.querySelector('.fc-takeaway')!.textContent).toBe('No shortfall, three gaps.');
    expect(container.querySelector('strong')!.textContent).toBe('no shortfall');
    getByText('1m 57s');
    getByText('354.2k tokens');
    getByText('Steps (3)');
    getByText(/all done/);
    getByText('Open in Frontier to download');
    expect(container.querySelector('a')).toBeNull();
  });

  it('the tree drops the shared root, lists files before folders and opens folders with deliverables', () => {
    const { container, getByText, getByRole } = render(<Card payload={mk({ status: 'done', deliverables: files })} />);
    expect(container.querySelector('.fc-loc-root')!.textContent).toBe('Review/');
    getByText('NEW FOLDER');
    getByText('Files · 4');
    const tree = getByRole('list', { name: 'Delivered files' });
    expect(container.querySelector('[role="tree"], [role="treeitem"]')).toBeNull();
    const top = Array.from(tree.children).map((li) => li.querySelector('button')!.querySelector('.fc-tname')!.textContent);
    expect(top).toEqual(['Summary.md', 'Letter.docx', 'Appendix/', 'notes/']);
    expect(getByRole('button', { name: /Appendix/ }).getAttribute('aria-expanded')).toBe('true');
    // All folders hold deliverables, so all start open.
    getByText('Cash flow.xlsx');
    getByText('raw.csv');
    // Every listed file is a deliverable: no per-file tag, no folder dot.
    expect(container.textContent).not.toContain('Deliverable');
    expect(container.querySelector('[aria-label="holds a deliverable"]')).toBeNull();
    // The path line starts on the first file and follows the selection.
    expect(container.querySelector('.fc-pathline')!.textContent).toBe('Workspace/Review/Summary.md');
    fireEvent.click(getByText('Cash flow.xlsx'));
    expect(container.querySelector('.fc-pathline')!.textContent).toBe('Workspace/Review/Appendix/Cash flow.xlsx');
    expect(getByRole('button', { name: /Cash flow.xlsx/ }).getAttribute('aria-current')).toBe('true');
    expect(getByRole('button', { name: /Summary.md/ }).getAttribute('aria-current')).toBeNull();
  });

  it('Collapse closes every folder and Expand all opens them again', () => {
    const { getByRole, queryByText, getByText } = render(<Card payload={mk({ status: 'done', deliverables: files })} />);
    fireEvent.click(getByRole('button', { name: 'Collapse' }));
    expect(queryByText('Cash flow.xlsx')).toBeNull();
    expect(queryByText('deep/')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Expand all' }));
    getByText('Cash flow.xlsx');
    getByText('raw.csv');
    fireEvent.click(getByRole('button', { name: /Appendix/ }));
    expect(queryByText('Cash flow.xlsx')).toBeNull();
  });

  it('flat files show a count instead of a folder and no expand controls', () => {
    const { container, queryByRole } = render(
      <Card payload={mk({ status: 'done', deliverables: [{ name: 'a.pdf', path: 'a.pdf' }, { name: 'b.pdf', path: 'b.pdf' }] })} />,
    );
    expect(container.querySelector('.fc-loc-root')!.textContent).toBe('2 files');
    expect(queryByRole('button', { name: 'Expand all' })).toBeNull();
  });

  it('skills hide behind a disclosure in the footer', () => {
    const { getByRole, queryByText, getByText } = render(
      <Card payload={mk({ status: 'done', skills: [{ playbook: 'Advisor Essentials', skill: 'Second opinion' }, { playbook: 'Advisor Dashboards', skill: 'Holdings' }] })} />,
    );
    const btn = getByRole('button', { name: /2 skills/ });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(queryByText('Second opinion')).toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    getByText('Second opinion');
    getByText('AE');
    getByText('Advisor Dashboards');
  });

  it('one skill reads in the singular; no skills, no button', () => {
    const a = render(<Card payload={mk({ status: 'done', skills: [{ playbook: 'Tax', skill: 'Organizer' }] })} />);
    a.getByRole('button', { name: /1 skill$/ });
    cleanup();
    const b = render(<Card payload={mk({ status: 'done' })} />);
    expect(b.queryByRole('button')).toBeNull();
  });

  const long = Array.from({ length: 30 }, (_, i) => `Line number ${i} of a long summary.`).join('\n\n');
  const doneWith = (summary: string, summary_type = 'markdown') => mk({ status: 'done', result: { summary, summary_type, takeaway: null } });

  it('summary_type text is shown verbatim, not as markdown', () => {
    const { container } = render(<Card payload={doneWith('keep **stars** literal', 'text')} />);
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('keep **stars** literal');
  });

  it('renders summary markup as text', () => {
    const { container } = render(<Card payload={doneWith('<img src=x onerror=alert(1)>')} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('a long summary collapses with an accessible Show more / Show less toggle', () => {
    const { getByRole, container, queryByRole } = render(<Card payload={doneWith(long)} />);
    const btn = getByRole('button', { name: 'Show more' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.fc-collapsed')).not.toBeNull();
    fireEvent.click(btn);
    expect(container.querySelector('.fc-collapsed')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Show less' }));
    expect(container.querySelector('.fc-collapsed')).not.toBeNull();
    cleanup();
    render(<Card payload={doneWith('Short and sweet.')} />);
    expect(queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('shows the server total_tokens and falls back to input + output', () => {
    const usage = { input_tokens: 90640, cached_input_tokens: 247938, output_tokens: 15645 };
    const a = render(<Card payload={mk({ status: 'done', usage: { ...usage, total_tokens: 358900 } })} />);
    a.getByText('358.9k tokens');
    cleanup();
    const b = render(<Card payload={mk({ status: 'done', usage })} />);
    b.getByText('106.3k tokens');
  });
});

describe('stopped and failed', () => {
  it('stopped says after how many steps, marks the rest not run and shows the footer', () => {
    const { getByText, container } = render(
      <Card payload={mk({ status: 'stopped', plan: steps('d', 'd', 'p', 'q', 'q'), live: 'gone', work_ms: 48000, usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 121600 } })} />,
    );
    getByText('Stopped after 2 of 5 steps. Nothing was delivered.');
    expect(container.querySelectorAll('[aria-label="Not run"]').length).toBe(3);
    expect(container.querySelectorAll('[aria-label="Done"]').length).toBe(2);
    getByText('Ask in the chat to start it again.');
    getByText('48s');
    getByText('121.6k tokens');
    expect(container.textContent).not.toContain('gone');
    expect(container.querySelector('.fc-now')).toBeNull();
  });

  it('failed shows the reason, the failed step and folds what never ran', () => {
    const { getByText, container, getByRole } = render(
      <Card payload={mk({
        status: 'error', plan: steps('p', 'q', 'q', 'q', 'q'), work_ms: 22000,
        events: [{ seq: 4, kind: 'error', text: 'The file stopped opening at page 31.' }],
      })} />,
    );
    getByText("Couldn't finish the task");
    getByText('The file stopped opening at page 31.');
    getByRole('img', { name: 'Failed here' });
    getByText('4 more steps not run');
    getByText('Ask in the chat to try again.');
    expect(container.querySelector('.fc-foot')).not.toBeNull();
  });

  it('a known error code reads in plain words; no event gives a generic line', () => {
    const a = render(<Card payload={mk({ status: 'error', events: [{ seq: 1, kind: 'error', text: 'x', code: 'run_timeout' }] })} />);
    a.getByText('The task ran out of time.');
    cleanup();
    const b = render(<Card payload={mk({ status: 'error' })} />);
    b.getByText('Something went wrong while the task was running.');
  });
});

describe('waiting without an ask', () => {
  it('says it is waiting and to reply in the chat', () => {
    const { getByText } = render(<Card payload={mk({ status: 'waiting_for_you', plan: steps('d', 'p') })} />);
    getByText('Frontier is waiting for you. Reply in the chat to carry on.');
    getByText(/1 of 2/);
    getByText('Clock stops while it waits');
  });
});

describe('source chip in the header', () => {
  const base = { task_id: 't', status: 'running', title: 'Financial Plan Summary', org: 'Halcyon North' };
  it('shows the tinted source next to the org line; nothing when null or unknown', () => {
    const p = parsePayload({ ...base, source: 'codex', turn: 2 })!;
    expect(p.source).toBe('codex');
    const { container } = render(<Card payload={p} />);
    const org = container.querySelector('.fc-org')!;
    expect(org.querySelector('.fc-src.fc-src-codex')!.textContent).toBe('Codex');
    expect(org.textContent).toBe('Halcyon North · Follow-up · turn 2 · Codex');
    cleanup();
    for (const source of [null, 'mystery-app', { a: 1 }, undefined]) {
      const q = parsePayload({ ...base, source })!;
      expect(q.source).toBeNull();
      const c = render(<Card payload={q} />);
      expect(c.container.querySelector('.fc-src')).toBeNull();
      cleanup();
    }
  });

  it('parsing twice keeps the source', () => {
    const once = parsePayload({ ...base, source: 'frontier' })!;
    expect(parsePayload(once)!.source).toBe('frontier');
  });
});
