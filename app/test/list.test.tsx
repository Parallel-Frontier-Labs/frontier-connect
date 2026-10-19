import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeleteOutcome, ListQuery } from '../src/bridge';
import { appendPage, parseList, type ListPayload } from '../src/list';
import { TaskList, type ListActions } from '../src/view/TaskList';

afterEach(cleanup);
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const item = (n: number, o: Record<string, unknown> = {}) => ({
  task_id: `t${n}`, title: `Task ${n}`, status: 'done', started_at: '2026-10-18T09:42:00Z', source: 'claude', work_ms: 117000, turn: 1, ...o,
});
const mkList = (o: Record<string, unknown> = {}): ListPayload =>
  parseList({
    view: 'list', items: [item(1)], total: 1, shown: 1, next_cursor: null, filters: { days: 7, status: null, source: null }, capped: false, ...o,
  })!;
const acts = (o: Partial<ListActions> = {}) => {
  const a = {
    enabled: true,
    query: vi.fn(async (_q: ListQuery, _append: boolean) => null as string | null),
    open: vi.fn(async (_id: string) => null as string | null),
    remove: vi.fn(async (_id: string): Promise<DeleteOutcome> => ({ kind: 'deleted' })),
    ...o,
  };
  return a;
};

describe('parseList', () => {
  it('accepts only view "list" and sanitises every row', () => {
    expect(parseList({ view: 'task', items: [] })).toBeNull();
    expect(parseList({ task_id: 't', status: 'done' })).toBeNull();
    expect(parseList({ view: 'list', items: 'x' })).toBeNull();
    const l = parseList({
      view: 'list', total: -3, shown: 'x', next_cursor: { a: 1 }, capped: 'yes',
      filters: { days: 400, status: '__proto__', source: 'desktop' },
      items: [
        item(1, { title: '<img src=x onerror=alert(1)>', status: 'bogus', source: 'mystery-app', work_ms: -5, turn: 0 }),
        item(2, { task_id: { a: 1 } }), 'x', null,
        item(3, { title: { a: 1 }, started_at: 'not a date', turn: 99999 }),
      ],
    })!;
    expect(l.items.map((i) => i.task_id)).toEqual(['t1', 't3']);
    expect(l.items[0]).toMatchObject({ status: 'done', source: 'other', work_ms: 0, turn: 1 });
    expect(l.items[1]).toMatchObject({ title: 'Untitled task', started_at: '', turn: 10000 });
    expect(l.filters).toEqual({ days: 90, status: null, source: 'frontier' });
    expect([l.total, l.shown, l.next_cursor, l.capped]).toEqual([2, 2, null, false]);
  });

  it('appendPage adds a page once per task id and takes the new counts and cursor', () => {
    const a = mkList({ items: [item(1), item(2)], total: 12, shown: 2, next_cursor: 'c1' });
    const b = mkList({ items: [item(2), item(3)], total: 12, shown: 4, next_cursor: null });
    const m = appendPage(a, b);
    expect(m.items.map((i) => i.task_id)).toEqual(['t1', 't2', 't3']);
    expect([m.shown, m.next_cursor]).toEqual([4, null]);
  });
});

describe('TaskList', () => {
  it('shows the header, filter summary and rows with status, start time, tinted source, duration and turn', () => {
    const l = mkList({
      org: 'Halcyon North', total: 14,
      items: [
        item(1, { status: 'running', source: 'claude', work_ms: 240000 }),
        item(2, { status: 'waiting', source: 'chatgpt' }),
        item(3, { status: 'done', source: 'codex', turn: 2 }),
        item(4, { status: 'error', source: 'scheduled' }),
        item(5, { status: 'stopped', source: 'frontier' }),
        item(6, { source: 'other' }),
      ],
      next_cursor: 'c',
    });
    const { getByText, container } = render(<TaskList list={l} actions={acts()} />);
    getByText('Your Frontier tasks');
    getByText('Last 7 days · Halcyon North');
    const pills = Array.from(container.querySelectorAll('.fc-pill')).map((p) => p.textContent);
    expect(pills).toEqual(['Working', 'Needs your answer', 'Done', 'Failed', 'Stopped', 'Done']);
    const chips = Array.from(container.querySelectorAll('.fc-src')).map((c) => `${c.className}|${c.textContent}`);
    expect(chips).toEqual([
      'fc-src fc-src-claude|Claude', 'fc-src fc-src-chatgpt|ChatGPT', 'fc-src fc-src-codex|Codex',
      'fc-src fc-src-scheduled|Scheduled', 'fc-src fc-src-frontier|Frontier', 'fc-src fc-src-other|Another AI app',
    ]);
    getByText('4m 0s so far');
    getByText('turn 2');
    expect(container.querySelectorAll('.fc-row')[0]!.textContent).toMatch(/Oct 1[89] · \d\d:42/);
    getByText('6 of 14');
  });

  it('filters re-query with the current filters plus the change, replacing the rows', async () => {
    const a = acts();
    const { getByLabelText } = render(<TaskList list={mkList({ filters: { days: 30, status: null, source: 'claude' } })} actions={a} />);
    const status = getByLabelText('Status') as HTMLSelectElement;
    const opts = Array.from(status.options).map((o) => o.text);
    expect(opts).toEqual(['All statuses', 'Working', 'Needs your answer', 'Done', 'Stopped', 'Failed']);
    fireEvent.change(status, { target: { value: String(opts.indexOf('Done')) } });
    await flush();
    expect(a.query).toHaveBeenCalledWith({ days: 30, status: 'done', source: 'claude' }, false);
    const days = getByLabelText('Dates') as HTMLSelectElement;
    expect(Array.from(days.options).map((o) => o.text)).toEqual(['Last 24 hours', 'Last 7 days', 'Last 30 days', 'Last 90 days']);
    fireEvent.change(days, { target: { value: '0' } });
    await flush();
    expect(a.query).toHaveBeenLastCalledWith({ days: 1, status: null, source: 'claude' }, false);
    const app = getByLabelText('App') as HTMLSelectElement;
    fireEvent.change(app, { target: { value: '0' } });
    await flush();
    expect(a.query).toHaveBeenLastCalledWith({ days: 30, status: null, source: null }, false);
  });

  it('a failed query shows its message', async () => {
    const a = acts({ query: vi.fn(async () => "Couldn't load your tasks. Try again, or ask in the chat.") });
    const { getByLabelText, getByText } = render(<TaskList list={mkList()} actions={a} />);
    fireEvent.change(getByLabelText('Status'), { target: { value: '1' } });
    await flush();
    getByText("Couldn't load your tasks. Try again, or ask in the chat.");
  });

  it('Show more sends the cursor with the same filters and appends', async () => {
    const a = acts();
    const { getByRole } = render(<TaskList list={mkList({ next_cursor: 'cur-1', total: 14, filters: { days: 7, status: 'done', source: null } })} actions={a} />);
    fireEvent.click(getByRole('button', { name: 'Show more' }));
    await flush();
    expect(a.query).toHaveBeenCalledWith({ days: 7, status: 'done', source: null, cursor: 'cur-1' }, true);
  });

  it('at the cap it says to narrow the dates or filters, with no Show more', () => {
    const items = Array.from({ length: 50 }, (_, i) => item(i));
    const { getByText, queryByRole } = render(<TaskList list={mkList({ items, total: 73, shown: 50, capped: true })} actions={acts()} />);
    getByText('Showing 50 of 73. Narrow the dates or filters to see more.');
    expect(queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('the row menu offers Open and Delete; a running or waiting task says Stop it first', () => {
    const l = mkList({ items: [item(1, { status: 'running' }), item(2, { status: 'waiting' }), item(3)] });
    const { getByRole, queryByRole, getAllByText } = render(<TaskList list={l} actions={acts()} />);
    const more = getByRole('button', { name: 'More actions for Task 1' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const del = getByRole('menuitem', { name: /Delete/ }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    getAllByText('Stop it first');
    fireEvent.keyDown(getByRole('menu'), { key: 'Escape' });
    expect(queryByRole('menu')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'More actions for Task 3' }));
    expect((getByRole('menuitem', { name: /Delete/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Delete asks inline with the exact copy; Cancel backs out without a call', () => {
    const a = acts();
    const { getByRole, getByText, queryByRole } = render(<TaskList list={mkList({ items: [item(1, { title: 'Okafor quarterly review' })] })} actions={a} />);
    fireEvent.click(getByRole('button', { name: 'More actions for Okafor quarterly review' }));
    fireEvent.click(getByRole('menuitem', { name: /Delete/ }));
    const dlg = getByRole('alertdialog');
    expect(dlg.textContent).toContain('Delete "Okafor quarterly review"?');
    getByText("This removes the task and its files. Its usage stays in Observe. This can't be undone.");
    const copy = `${dlg.querySelector('.fc-confirm-h')!.textContent} ${dlg.querySelector('.fc-confirm-d')!.textContent}`;
    expect(copy).toBe(`Delete "Okafor quarterly review"? This removes the task and its files. Its usage stays in Observe. This can't be undone.`);
    expect(document.activeElement).toBe(getByRole('button', { name: 'Cancel' }));
    fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(queryByRole('alertdialog')).toBeNull();
    expect(a.remove).not.toHaveBeenCalled();
  });

  it('confirmed Delete calls remove once; a refusal shows the reason and keeps the confirm open', async () => {
    const a = acts({ remove: vi.fn(async (): Promise<DeleteOutcome> => ({ kind: 'refused', reason: 'Stop the task first.' })) });
    const { getByRole, getByText } = render(<TaskList list={mkList()} actions={a} />);
    fireEvent.click(getByRole('button', { name: 'More actions for Task 1' }));
    fireEvent.click(getByRole('menuitem', { name: /Delete/ }));
    fireEvent.click(getByRole('button', { name: 'Delete' }));
    await flush();
    expect(a.remove).toHaveBeenCalledTimes(1);
    expect(a.remove).toHaveBeenCalledWith('t1');
    getByText('Stop the task first.');
    getByRole('alertdialog');
  });

  it('a deleted task is announced', async () => {
    const a = acts();
    const { getByRole, container } = render(<TaskList list={mkList()} actions={a} />);
    fireEvent.click(getByRole('button', { name: 'More actions for Task 1' }));
    fireEvent.click(getByRole('menuitem', { name: /Delete/ }));
    fireEvent.click(getByRole('button', { name: 'Delete' }));
    await flush();
    expect(container.querySelector('[aria-live="polite"]')!.textContent).toBe('Deleted "Task 1".');
  });

  it('a title opens the task; an open failure is shown on the row', async () => {
    const a = acts({ open: vi.fn(async () => "Couldn't open the task. Try again, or ask in the chat.") });
    const { getByRole, getByText } = render(<TaskList list={mkList()} actions={a} />);
    fireEvent.click(getByRole('button', { name: 'Task 1' }));
    await flush();
    expect(a.open).toHaveBeenCalledWith('t1');
    getByText("Couldn't open the task. Try again, or ask in the chat.");
  });

  it('without app tool calls the list is read-only', () => {
    const { queryByRole, queryByLabelText, getByText, container } = render(
      <TaskList list={mkList({ next_cursor: 'c', total: 12 })} actions={acts({ enabled: false })} />,
    );
    expect(queryByLabelText('Status')).toBeNull();
    expect(queryByRole('button')).toBeNull();
    expect(container.querySelector('.fc-moreb')).toBeNull();
    getByText('Ask in the chat to filter or open a task');
    getByText('Task 1');
  });

  it('empty lists say so, with or without filters', () => {
    const a = render(<TaskList list={mkList({ items: [], total: 0, shown: 0 })} actions={acts()} />);
    a.getByText('No tasks in the last 7 days.');
    cleanup();
    const b = render(<TaskList list={mkList({ items: [], total: 0, shown: 0, filters: { days: 30, status: 'error', source: null } })} actions={acts()} />);
    b.getByText('No tasks match these filters in the last 30 days.');
  });

  it('hostile titles render as text', () => {
    const { container } = render(<TaskList list={mkList({ items: [item(1, { title: '<img src=x onerror=alert(1)>' })] })} actions={acts()} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('applies the theme', () => {
    const { container } = render(<TaskList list={mkList()} theme="dark" actions={acts()} />);
    expect(container.querySelector('.fc-card')!.getAttribute('data-theme')).toBe('dark');
  });
});

describe('TaskList row menu placement', () => {
  // jsdom has no layout: give the card, row, "…" trigger and menu fixed boxes (viewport coords).
  const box = (top: number, height: number) =>
    ({ top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  const layout = (o: { cardTop: number; cardBottom: number; viewport: number }) => {
    vi.stubGlobal('innerHeight', o.viewport);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList.contains('fc-card')) return box(o.cardTop, o.cardBottom - o.cardTop);
      if (this.classList.contains('fc-menu')) return box(0, 82);
      if (this.classList.contains('fc-moreb')) return box(120, 32);
      if (this.classList.contains('fc-row')) return box(110, 62);
      return box(0, 0);
    });
  };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const openMenu = () => {
    const r = render(<TaskList list={mkList()} actions={acts()} />);
    fireEvent.click(r.getByRole('button', { name: 'More actions for Task 1' }));
    return { ...r, menu: r.getByRole('menu') as HTMLElement };
  };

  it('a single-row list opens the menu upward when the space below the trigger is short', () => {
    layout({ cardTop: 0, cardBottom: 200, viewport: 200 }); // 44px below the trigger, 116px above
    const { menu, container, getByRole } = openMenu();
    expect(menu.getAttribute('data-placement')).toBe('up');
    expect(menu.style.top).toBe('-76px'); // trigger top (10px into the row) - 82px menu - 4px gap
    expect(container.querySelector('.fc-menu-room')).toBeNull();
    // Keyboard and focus are unchanged: focus lands on Open, Escape closes and returns focus.
    expect(document.activeElement).toBe(getByRole('menuitem', { name: 'Open' }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(document.activeElement).toBe(getByRole('button', { name: 'More actions for Task 1' }));
  });

  it('opens downward when there is room below', () => {
    layout({ cardTop: 0, cardBottom: 400, viewport: 400 });
    const { menu, container } = openMenu();
    expect(menu.getAttribute('data-placement')).toBe('down');
    expect(menu.style.top).toBe('46px'); // trigger bottom (42px into the row) + 4px gap
    expect(container.querySelector('.fc-menu-room')).toBeNull();
  });

  it('the viewport bounds the space below as well as the card', () => {
    layout({ cardTop: 0, cardBottom: 400, viewport: 200 });
    expect(openMenu().menu.getAttribute('data-placement')).toBe('up');
  });

  it('when neither side fits, opens downward and grows the card so the reported size includes the menu', () => {
    layout({ cardTop: 100, cardBottom: 200, viewport: 200 }); // 44px below, 16px above
    const { menu, container, getByRole } = openMenu();
    expect(menu.getAttribute('data-placement')).toBe('down');
    const room = container.querySelector('.fc-card > .fc-menu-room') as HTMLElement;
    expect(room.style.height).toBe('38px'); // 82px menu - 44px below
    // Closing the menu (click outside) gives the room back.
    fireEvent.mouseDown(document.body);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('.fc-menu-room')).toBeNull();
    // The delete confirm still works from a flipped or grown menu.
    fireEvent.click(getByRole('button', { name: 'More actions for Task 1' }));
    fireEvent.click(getByRole('menuitem', { name: /Delete/ }));
    getByRole('alertdialog');
    expect(container.querySelector('.fc-menu-room')).toBeNull();
  });

  it('moving straight from one row\'s menu to another keeps the room the new menu needs', () => {
    layout({ cardTop: 100, cardBottom: 200, viewport: 200 });
    const { getByRole, container } = render(<TaskList list={mkList({ items: [item(1), item(2)], total: 2, shown: 2 })} actions={acts()} />);
    fireEvent.click(getByRole('button', { name: 'More actions for Task 2' }));
    fireEvent.click(getByRole('button', { name: 'More actions for Task 1' }));
    expect(getByRole('menu').getAttribute('aria-label')).toBe('Task 1 actions');
    expect((container.querySelector('.fc-menu-room') as HTMLElement).style.height).toBe('38px');
  });
});
