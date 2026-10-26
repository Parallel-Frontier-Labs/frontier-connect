import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AnswerOutcome, Answers, Stale } from '../bridge';
import { cardClass } from '../format';
import type { Status, TaskPayload } from '../types';
import { AnsweredView, type Answered } from './Answered';
import { BrowserPreview, type BrowserApi } from './BrowserPreview';
import { ControlView, SignInPanel } from './BrowserTakeover';
import { Done } from './Done';
import { Ended } from './Ended';
import { FilesAsk } from './FilesAsk';
import { NO_DOWNLOADS, type DownloadApi, type FilePreview } from './Files';
import { Footer } from './Footer';
import { FormAsk } from './FormAsk';
import { Mark, Now } from './icons';
import { SourceChip } from './TaskList';
import { NoPlan } from './Sections';
import { PausedSteps, PlanProgress, progressKey } from './Plan';
import { QuestionAsk } from './Ask';
import { NO_PREVIEW, PreviewPane, type PreviewGate } from './PreviewPane';
import type { UploadApi } from './UploadPanel';

/** How the card answers: through the host's app tool call, when the host offers one. */
export interface AnswerApi {
  enabled: boolean;
  send(askId: string, answers: Answers): Promise<AnswerOutcome | Stale>;
}

/** How long the host gets to answer a display-mode request before the card goes on inline. */
export const DISPLAY_MODE_WAIT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(null); },
    );
  });
}

/** The seq of the task's latest takeover event (0 when none): a new one means it needs the user again. */
function latestTakeoverSeq(p: TaskPayload): number {
  for (let i = p.events.length - 1; i >= 0; i--) if (p.events[i]!.kind === 'takeover') return p.events[i]!.seq;
  return 0;
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
  embedded = true,
  answer = NO_ANSWERS,
  download,
  onBack,
  browser,
  upload,
  preview = NO_PREVIEW,
}: {
  payload: TaskPayload;
  theme?: 'light' | 'dark';
  /** Inside the host's own frame: no outer border, radius or shadow (see cardClass). */
  embedded?: boolean;
  answer?: AnswerApi;
  /** Download buttons for the delivered files (hosts that forward the card's tool calls). */
  download?: DownloadApi;
  /** Card uploads: the ask for a file and the finished-task Files section. */
  upload?: UploadApi;
  /** Opened from "Your Frontier tasks": a "← All tasks" bar returns to the list. */
  onBack?: () => void;
  /** The task's cloud browser (frames, display modes): a live preview while the agent drives it. */
  browser?: BrowserApi;
  /** Full-screen file preview beside the task (hosts that offer full screen; NO_PREVIEW elsewhere). */
  preview?: PreviewGate;
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

  // The task paused for the user in its browser, and the card can drive it: sign-in panel, then the
  // control view (full screen when the host grants it, inline otherwise).
  // The task waits on the user in its browser. A sign-in the card can drive (input, direct
  // transport) gets Take over; otherwise the panel says where to continue: a form in the browser,
  // or a host that cannot reach the browser, goes to Frontier.
  const browserWait = !!browser && p.status === 'waiting_for_you' && p.browser?.state === 'waiting';
  const transport = browser?.transport?.() ?? 'direct';
  // A host that never let the card reach the server goes to Frontier; a direct path that dropped
  // after working (a network blip) keeps the panel, with Take over waiting on the reconnect.
  const takeover = browserWait && !p.browser?.form && !!browser?.input && transport !== 'blocked';
  const reconnecting = transport === 'reconnecting';
  const elsewhere: 'form' | 'host' | null = !browserWait || takeover ? null : p.browser?.form ? 'form' : 'host';
  const [control, setControl] = useState(false);
  // Resumed from this card: until the task picks it up, say so instead of offering the panel again.
  // Tied to the takeover it answered, so a new takeover (the task needs the user again) shows.
  const [resumedFor, setResumedFor] = useState<number | null>(null);
  const takeoverSeq = latestTakeoverSeq(p);
  const resumed = resumedFor !== null && resumedFor === takeoverSeq;
  const leaving = useRef(false);
  const alive = useRef(true);
  const articleRef = useRef<HTMLElement>(null);
  // Back from the control view: keyboard focus returns to Take over (or the card).
  const [refocus, setRefocus] = useState(false);
  useEffect(() => () => {
    alive.current = false;
  }, []);
  const leave = (didResume: boolean) => {
    if (leaving.current) return;
    leaving.current = true;
    setControl(false);
    setRefocus(true);
    if (didResume) {
      setResumedFor(takeoverSeq);
      browser?.refresh?.();
    }
    void browser?.requestDisplayMode('inline');
  };
  const takeOver = async () => {
    if (!browser) return;
    // Whatever the host answers, the control view opens: full screen when granted, inline when
    // refused or when the host does not answer within DISPLAY_MODE_WAIT_MS.
    await withTimeout(browser.requestDisplayMode('fullscreen'), DISPLAY_MODE_WAIT_MS);
    if (!alive.current) return;
    leaving.current = false;
    setControl(true);
  };
  // Leave the control view when the task stops waiting (resumed elsewhere, finished, stopped).
  useEffect(() => {
    if (control && !takeover) leave(false);
    if (!takeover) setResumedFor(null);
  }, [takeover]);
  // Focus after leaving the control view: Take over when the panel is back, else the card itself.
  useEffect(() => {
    if (!refocus || control) return;
    setRefocus(false);
    if (!articleRef.current?.querySelector('.fc-takeover')) articleRef.current?.focus();
  }, [refocus, control]);
  // The host left full screen on its own (its close button): back to the card.
  const prevMode = useRef(browser?.mode);
  useEffect(() => {
    const was = prevMode.current;
    prevMode.current = browser?.mode;
    if (control && was === 'fullscreen' && browser?.mode !== 'fullscreen') {
      leaving.current = true;
      setControl(false);
      setRefocus(true);
    }
  }, [browser?.mode]);
  // The delivered file shown full screen beside the task (hosts that offer full screen).
  const [pv, setPvState] = useState<{ path: string; name: string } | null>(null);
  // Mirrors pv at once (not on the next render), for the late-grant and unmount checks below.
  const pvRef = useRef(pv);
  const setPv = (v: { path: string; name: string } | null) => { pvRef.current = v; setPvState(v); };
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const narrow = useNarrow();
  // Only the latest row click may open the preview.
  const openSeq = useRef(0);
  // Full-screen requests still unanswered, and whether one was granted that no preview took.
  const inflight = useRef(0);
  const stray = useRef(false);
  /** Full screen granted: the file opens. Refused, or no answer in time: `refused` (the row downloads). */
  const openFile = (path: string, name: string, refused: () => void) => {
    if (!preview.enabled) return refused();
    const n = ++openSeq.current;
    const latest = () => n === openSeq.current && alive.current;
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; if (latest()) refused(); }, DISPLAY_MODE_WAIT_MS);
    inflight.current += 1;
    void preview.open().then((v) => v === true, () => false).then((granted) => {
      clearTimeout(t);
      inflight.current -= 1;
      // A later click took over, the card is gone, or the answer came too late: neither opens nor downloads.
      if (latest() && !timedOut) {
        if (granted) { setPv({ path, name }); return; }
        refused();
      } else if (granted) stray.current = true;
      // A grant no preview took leaves the host full screen with nothing in it: go back to inline,
      // once no newer request is pending (it may still open a file).
      if (stray.current && inflight.current === 0 && !pvRef.current) {
        stray.current = false;
        void previewRef.current.close();
      }
    });
  };
  // Gone while a file is open (another task, the list): leave full screen too.
  useEffect(() => () => {
    if (pvRef.current) void previewRef.current.close();
  }, []);
  // Back from the preview (Close preview, Back to the task): focus returns to the file's row.
  const [refocusPath, setRefocusPath] = useState<string | null>(null);
  const leavePreview = (close: boolean) => {
    if (pv) setRefocusPath(pv.path);
    setPv(null);
    if (close) void preview.close();
  };
  useEffect(() => {
    if (refocusPath === null || pv) return;
    setRefocusPath(null);
    const row = Array.from(articleRef.current?.querySelectorAll<HTMLElement>('.fc-trow[data-path]') ?? []).find((el) => el.dataset.path === refocusPath);
    (row ?? articleRef.current)?.focus();
  }, [refocusPath, pv]);
  const filePreview: FilePreview = { enabled: preview.enabled, onOpen: openFile, openPath: pv?.path ?? null };
  // The host left full screen on its own (its close button): the preview closes, focus back on its row.
  const prevPvMode = useRef(preview.mode);
  useEffect(() => {
    const was = prevPvMode.current;
    prevPvMode.current = preview.mode;
    if (was === 'fullscreen' && preview.mode !== 'fullscreen' && pvRef.current) leavePreview(false);
  }, [preview.mode]);
  const announcement = `Frontier task ${PILL.get(p.status) ?? 'Starting'}${showAnswered ? `. ${answered!.label}, continuing` : ''}.`;

  let body = null;
  if (terminal) {
    body = p.status === 'done' ? <Done payload={p} download={download} upload={upload} preview={filePreview} />
      : <Ended payload={p} download={download} upload={upload} preview={filePreview} />;
  } else if (waiting && ask && !lockedAsk) {
    const send = (answers: Answers) => answer.send(ask.ask_id!, answers);
    const askView =
      ask.kind === 'form' ? (
        <FormAsk key={ask.ask_id} ask={ask} canSend={canSend} send={send} onSent={onSent} />
      ) : ask.kind === 'files' ? (
        <FilesAsk key={ask.ask_id} ask={ask} taskId={p.task_id} upload={upload} canSend={canSend} send={send} onSent={onSent} />
      ) : (
        <QuestionAsk key={ask.ask_id} ask={ask} canSend={canSend} send={send} onSent={onSent} />
      );
    body = ask.kind === 'form' ? askView : (
      <div class="fc-body">
        {askView}
        <PausedSteps payload={p} />
      </div>
    );
  } else if (takeover && browser && resumed) {
    body = (
      <div class="fc-body">
        <p class="fc-note" role="status">Resuming the task…</p>
        <PausedSteps payload={p} />
      </div>
    );
  } else if (takeover && browser) {
    body = <SignInPanel payload={p} api={browser} onTakeOver={() => void takeOver()} focus={refocus} reconnecting={reconnecting} />;
  } else if (elsewhere && browser) {
    body = <SignInPanel payload={p} api={browser} elsewhere={elsewhere} />;
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
        {browser && p.status === 'running' && p.browser?.state === 'live' ? <BrowserPreview site={p.browser.site} api={browser} /> : null}
      </>
    );
  }

  // The same wrappers on every render, so the card body never remounts when the preview opens or
  // closes (an open upload, expanded folders): outside the split they are display: contents.
  const split = !!pv && preview.mode === 'fullscreen';
  const shell = (main: JSX.Element) => {
    const sa = split ? preview.safeArea : undefined;
    const pad = sa ? { paddingTop: `${sa.top}px`, paddingRight: `${sa.right}px`, paddingBottom: `${sa.bottom}px`, paddingLeft: `${sa.left}px` } : undefined;
    return (
      <div class={split ? 'fc-split' : 'fc-split-off'} style={pad} data-theme={split ? theme : undefined}>
        <div class={split ? 'fc-split-main' : 'fc-split-off'} hidden={split && narrow}>{main}</div>
        {split && pv ? (
          <div class="fc-split-side">
            {narrow ? <button type="button" class="fc-toggle" onClick={() => leavePreview(false)}>Back to the task</button> : null}
            <PreviewPane key={pv.path} file={pv} api={preview.api} download={download ?? NO_DOWNLOADS} onClose={() => leavePreview(true)} />
          </div>
        ) : null}
      </div>
    );
  };

  if (control && takeover && browser) {
    const full = browser.mode === 'fullscreen';
    return shell(
      <article class={`${cardClass(embedded)} fc-card-ctl${full ? ' fc-card-full' : ''}`} data-theme={theme} aria-label={`Frontier task: ${p.title || 'Frontier task'}, you're in control`}>
        <ControlView payload={p} api={browser} fullscreen={full} onLeave={leave} />
      </article>,
    );
  }

  const article = (
    <article ref={articleRef} tabIndex={-1} class={cardClass(embedded)} data-theme={theme} aria-label={`Frontier task: ${p.title || 'Frontier task'}`}>
      {onBack ? (
        <div class="fc-backbar">
          <button type="button" class="fc-back" onClick={onBack}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M11 7H3M6.5 3.5L3 7l3.5 3.5" />
            </svg>
            All tasks
          </button>
        </div>
      ) : null}
      <header class="fc-head">
        <Mark />
        <div class="fc-heading">
          <div class="fc-title">{p.title || 'Frontier task'}</div>
          <div class="fc-org">
            {p.org ? <span class="fc-org-name">{p.org}</span> : 'Frontier'}
            {followUp ? ` · Follow-up · turn ${p.turn}` : p.org ? ' · Frontier' : null}
            {p.source ? <> · <SourceChip source={p.source} /></> : null}
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

  return shell(article);
}

const NARROW = '(max-width: 899px)';

/** True below 900 px wide: the preview then takes the whole view, with a way back to the task. */
function useNarrow(): boolean {
  const mq = () => (typeof window !== 'undefined' ? window.matchMedia?.(NARROW) : undefined);
  const [narrow, setNarrow] = useState(() => !!mq()?.matches);
  useEffect(() => {
    const m = mq();
    if (!m?.addEventListener) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}
