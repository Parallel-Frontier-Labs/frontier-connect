import type { JSX } from 'preact';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import type { BrowserFrame } from '../browserFeed';
import {
  ClickCounter, heldButton, InputQueue, isPasteChord, keyInput, mouseButton, mouseInput, pasteInputs, resizeInput, toRemote,
  wheelInput, type BrowserInput, type MouseButton, type Mods,
} from '../browserInput';
import type { TaskPayload } from '../types';
import { BrowserStage, ExpandIcon, type BrowserApi } from './BrowserPreview';
import { Mark } from './icons';
import { PausedSteps } from './Plan';

export const TAKEOVER_FALLBACK = 'The agent is waiting for you in its browser. Take over, sign in, then press Done, resume task.';
export const CONTROL_HINT =
  "Your clicks and typing go straight to the task's browser. Password managers can't fill this view: copy your password and use Paste.";
export const RESUME_FAILED = "Couldn't resume the task. Try again.";
export const STOP_FAILED = "Couldn't stop the task. Try again.";
export const SEND_FAILED_NOTE = "Couldn't send that. Try again.";
export const RECONNECTING = 'Reconnecting…';
export const ESC_HINT = 'Esc leaves the browser';
/** Inline (the host kept the card in the chat): the canvas is at most this tall… */
export const INLINE_MAX_PX = 640;
/** …and leaves room for the control view's header, site bar and hint within the host's height. */
export const CONTROL_CHROME_PX = 176;
const INLINE_MIN_PX = 200;

export const signInTitle = (site: string | null | undefined) => (site ? `Sign in to ${site}` : 'The browser needs you');
export const ELSEWHERE_HOST =
  "This app can't control the task's browser. Open the task in Frontier to sign in, then resume it there.";
export const FORM_TITLE = 'Frontier needs a few details';
/** A pause the user asked for (Take control), from this card or another one. */
export const USER_PAUSE_TEXT = 'The agent is paused so you can drive.';
export const USER_CONTROL_TITLE = "You're in control · the agent is paused";
export const ELSEWHERE_FORM = 'The task is waiting for details in its browser. Continue in Frontier to fill them in.';

/** The latest "the browser needs you" line the task wrote, if any. */
export function takeoverText(p: TaskPayload): string {
  for (let i = p.events.length - 1; i >= 0; i--) {
    const e = p.events[i]!;
    if (e.kind === 'takeover' && e.text.trim()) return e.text.trim();
  }
  return TAKEOVER_FALLBACK;
}

/** Canvas height for the inline control view: min(640, host height − chrome), at least 200. */
export function inlineHeight(c: { height?: number; maxHeight?: number } | undefined): number {
  const host = c?.maxHeight ?? c?.height;
  const room = typeof host === 'number' && Number.isFinite(host) ? host - CONTROL_CHROME_PX : INLINE_MAX_PX;
  return Math.max(INLINE_MIN_PX, Math.min(INLINE_MAX_PX, Math.round(room)));
}

function LockIcon() {
  return (
    <svg class="fc-signin-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="4" y="9" width="12" height="8" rx="2" />
      <path d="M7 9V6.5a3 3 0 016 0V9" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
      <path d="M3.5 2.2v9.6L11.5 7z" />
    </svg>
  );
}

/** The task paused for the user in its browser (design board 2): the sign-in panel and the paused
 * preview. Clicking the preview is the same as Take over. */
export function SignInPanel({
  payload: p,
  api,
  onTakeOver,
  focus = false,
  elsewhere = null,
  reconnecting = false,
}: {
  payload: TaskPayload;
  api: BrowserApi;
  /** Absent when the user continues elsewhere (see `elsewhere`). */
  onTakeOver?: () => void;
  /** No takeover here: a form in the task's browser, or a host that cannot reach the browser.
   * The panel says to continue in Frontier; there is no button that leads nowhere. */
  elsewhere?: 'form' | 'host' | null;
  /** Put keyboard focus on Take over (back from the control view). */
  focus?: boolean;
  /** The direct path dropped after working: Take over waits for it to come back. */
  reconnecting?: boolean;
}) {
  const id = useId();
  const site = p.browser?.site ?? null;
  // The user asked for this pause (Take control): not a sign-in.
  const user = !!p.browser?.user;
  const [stopping, setStopping] = useState(false);
  const [stopErr, setStopErr] = useState(false);
  const takeBtn = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);
  useEffect(() => {
    if (focus) takeBtn.current?.focus();
  }, [focus]);
  const stop = api.stop;
  const onStop = async () => {
    if (!stop) return;
    setStopping(true);
    setStopErr(false);
    const ok = await stop().catch(() => false);
    if (!alive.current) return;
    setStopping(false);
    setStopErr(!ok);
  };
  return (
    <div class="fc-body">
      <section class="fc-askbox fc-signin" aria-labelledby={`${id}-h`}>
        <div class="fc-signin-row">
          <LockIcon />
          <div class="fc-signin-text">
            <h3 id={`${id}-h`} class="fc-signin-title">{elsewhere === 'form' ? FORM_TITLE : user ? signInTitle(null) : signInTitle(site)}</h3>
            <p class="fc-signin-body">
              {elsewhere === 'form' ? ELSEWHERE_FORM : elsewhere === 'host' ? ELSEWHERE_HOST : user ? USER_PAUSE_TEXT : takeoverText(p)}
            </p>
          </div>
        </div>
        <div class="fc-signin-actions">
          {!elsewhere && onTakeOver ? (
            <button type="button" class="fc-primary fc-takeover" ref={takeBtn} onClick={onTakeOver} disabled={reconnecting}>
              <ExpandIcon size={15} />
              Take over
            </button>
          ) : null}
          {!elsewhere && reconnecting ? <span class="fc-muted fc-reconnecting" role="status">{RECONNECTING}</span> : null}
          {stop ? (
            <button type="button" class="fc-secondary" disabled={stopping} onClick={() => void onStop()}>
              Stop task
            </button>
          ) : null}
        </div>
        {stopErr ? <p class="fc-err" role="alert">{STOP_FAILED}</p> : null}
      </section>
      {elsewhere ? null : <div class="fc-bv fc-bv-in">
        <section class="fc-bv-box" aria-label="Browser, paused">
          <div class="fc-bv-bar">
            <span class="fc-bv-live fc-bv-held">
              <span class="fc-bv-dot" aria-hidden="true" />
              Paused
            </span>
            <span class="fc-bv-site">{site ?? ''}</span>
            <span class="fc-bv-hint">Click the preview to take over</span>
          </div>
          <div class="fc-bv-takewrap">
            <BrowserStage api={api} label={site ? `The task’s browser on ${site}, paused` : 'The task’s browser, paused'} />
            {/* A button over the picture (not around it: a button holds no blocks). */}
            <button type="button" class="fc-bv-take" aria-label="Take over the browser" onClick={onTakeOver} disabled={reconnecting} />
          </div>
        </section>
      </div>}
      <PausedSteps payload={p} />
    </div>
  );
}

const raf = (fn: () => void): unknown =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16);
const unraf = (h: unknown) =>
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(h as number) : clearTimeout(h as ReturnType<typeof setTimeout>);

/**
 * The user drives the task's browser (design board 3, the panel): header with Done, resume task
 * and close, the site bar with Paste, the interactive canvas and the hint. Full screen it fills the
 * frame; inline it is as tall as the host allows (at most 640 px of canvas). Input goes out one
 * event at a time; keyboard handlers sit on the canvas only.
 */
export function ControlView({
  payload: p,
  api,
  fullscreen,
  onLeave,
}: {
  payload: TaskPayload;
  api: BrowserApi;
  fullscreen: boolean;
  /** Leave the control view. `resumed`: the task was resumed from here. */
  onLeave: (resumed: boolean) => void;
}) {
  const site = p.browser?.site ?? null;
  const [frameSite, setFrameSite] = useState<string | null>(null);
  const shown = frameSite ?? site;
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const doneBtn = useRef<HTMLButtonElement>(null);
  const pasteField = useRef<HTMLInputElement>(null);
  const frame = useRef<{ w: number; h: number } | null>(null);
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const hintId = useId();

  // Input is bound to the task this view opened for: a queued batch (it can be a password) never
  // goes to another task, and whatever is still queued is dropped when the view goes away.
  const taskId = useRef(p.task_id).current;
  const [sendErr, setSendErr] = useState(false);
  const errTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useMemo(
    () =>
      new InputQueue(
        (evs) => (api.input ? api.input(taskId, evs) : Promise.resolve('failed')),
        () => leaveRef.current(false),
        undefined,
        () => {
          setSendErr(true);
          if (errTimer.current) clearTimeout(errTimer.current);
          errTimer.current = setTimeout(() => setSendErr(false), 4000);
        },
      ),
    [],
  );
  useEffect(() => () => {
    queue.close();
    if (errTimer.current) clearTimeout(errTimer.current);
  }, []);
  useEffect(() => {
    if (p.task_id !== taskId) queue.close();
  }, [p.task_id]);

  // Keyboard focus goes to the browser on entering control.
  useEffect(() => {
    canvas.current?.focus();
  }, []);

  // Tell the browser its viewport: the canvas box, once per size change (dpr 1).
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    let last = '';
    let pending: unknown = null;
    const measure = () => {
      pending = null;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w <= 0 || h <= 0) return;
      const ev = resizeInput(w, h);
      const key = ev.kind === 'resize' ? `${ev.width}x${ev.height}` : '';
      if (key === last) return;
      last = key;
      queue.push(ev);
    };
    const soon = () => {
      if (pending === null) pending = raf(measure);
    };
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(soon);
      ro.observe(el);
    } else soon();
    return () => {
      ro?.disconnect();
      if (pending !== null) unraf(pending);
    };
  }, []);

  // Mouse moves: at most one per animation frame.
  const move = useRef<{ ev: BrowserInput | null; h: unknown }>({ ev: null, h: null });
  useEffect(() => () => {
    if (move.current.h !== null) unraf(move.current.h);
  }, []);
  const dropMove = () => {
    if (move.current.h !== null) unraf(move.current.h);
    move.current = { ev: null, h: null };
  };

  const at = (e: { clientX: number; clientY: number }, clampOutside = false) => {
    const c = canvas.current;
    const f = frame.current;
    if (!c || !f) return null;
    const r = c.getBoundingClientRect();
    return toRemote(e.clientX - r.left, e.clientY - r.top, { width: r.width, height: r.height }, f, clampOutside);
  };
  const clicks = useMemo(() => new ClickCounter(), []);
  const held = useRef<{ button: MouseButton; pos: { x: number; y: number }; n: number } | null>(null);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const release = () => {
    const h = held.current;
    if (!h) return;
    held.current = null;
    dropMove();
    queue.push(mouseInput('mouseReleased', h.pos, h.button, h.n));
  };
  const mods = (e: KeyboardEvent): Mods => ({ ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey });

  const canvasProps: JSX.HTMLAttributes<HTMLCanvasElement> = {
    tabIndex: 0,
    'aria-describedby': hintId,
    onPointerDown: (e) => {
      canvas.current?.focus();
      const pos = at(e);
      if (!pos) return;
      e.preventDefault();
      try {
        canvas.current?.setPointerCapture?.(e.pointerId);
      } catch {
        /* not every pointer can be captured */
      }
      dropMove();
      const button = mouseButton(e.button);
      const r = canvas.current!.getBoundingClientRect();
      const n = clicks.press(button, e.clientX - r.left, e.clientY - r.top, now());
      held.current = { button, pos, n };
      queue.push(mouseInput('mousePressed', pos, button, n));
    },
    onPointerUp: (e) => {
      const pos = at(e, true);
      const h = held.current;
      held.current = null;
      if (!pos) return;
      dropMove();
      const button = h?.button ?? mouseButton(e.button);
      queue.push(mouseInput('mouseReleased', pos, button, h?.n ?? clicks.count));
    },
    // A drag the system cancelled (touch pan, focus change): release the button where it was.
    onPointerCancel: () => release(),
    onLostPointerCapture: () => release(),
    onPointerMove: (e) => {
      const pos = at(e);
      if (!pos) return;
      if (held.current) held.current.pos = pos;
      move.current.ev = mouseInput('mouseMoved', pos, heldButton(e.buttons));
      if (move.current.h === null) {
        move.current.h = raf(() => {
          const ev = move.current.ev;
          move.current = { ev: null, h: null };
          if (ev) queue.push(ev);
        });
      }
    },
    onWheel: (e) => {
      const pos = at(e);
      if (!pos) return;
      e.preventDefault();
      queue.push(wheelInput(pos, e.deltaX, e.deltaY, e.deltaMode, frame.current?.h));
    },
    onContextMenu: (e) => e.preventDefault(),
    onKeyDown: (e) => {
      if (e.isComposing) return;
      // Escape hands keyboard focus back to the card (the browser view never traps it).
      if (e.key === 'Escape') {
        e.preventDefault();
        doneBtn.current?.focus();
        return;
      }
      // Cmd/Ctrl+V: let the browser raise a paste event (onPaste sends its text).
      if (isPasteChord(e.key, mods(e))) return;
      const ev = keyInput('keydown', e.key, e.code, mods(e));
      if (!ev) return;
      e.preventDefault();
      queue.push(ev);
    },
    onKeyUp: (e) => {
      if (e.isComposing || e.key === 'Escape' || isPasteChord(e.key, mods(e))) return;
      const ev = keyInput('keyup', e.key, e.code, mods(e));
      if (!ev) return;
      e.preventDefault();
      queue.push(ev);
    },
    onPaste: (e) => {
      e.preventDefault();
      for (const ev of pasteInputs(e.clipboardData?.getData('text/plain') ?? '')) queue.push(ev);
    },
  };

  const done = async () => {
    setBusy(true);
    setErr(null);
    const r = await queue.send({ kind: 'resume' });
    // not_waiting: resumed elsewhere; the queue has already left the control view.
    if (r === 'ok') leaveRef.current(true);
    else if (r === 'failed') {
      setBusy(false);
      setErr(RESUME_FAILED);
    }
  };

  const sendPaste = (e: Event) => {
    e.preventDefault();
    for (const ev of pasteInputs(pasteText)) queue.push(ev);
    setPasteText('');
    setPasteOpen(false);
    canvas.current?.focus();
  };

  useEffect(() => {
    if (pasteOpen) pasteField.current?.focus();
  }, [pasteOpen]);

  const style = fullscreen ? undefined : { height: `${inlineHeight(api.container?.())}px` };
  return (
    <section class={fullscreen ? 'fc-ctl fc-ctl-full' : 'fc-ctl'} aria-label="Frontier browser panel">
      <header class="fc-ctl-head">
        <Mark />
        <div class="fc-ctl-heading">
          {p.browser?.user ? (
            <div class="fc-ctl-title">{USER_CONTROL_TITLE}</div>
          ) : (
            <>
              <div class="fc-ctl-title">{signInTitle(shown)}</div>
              <div class="fc-ctl-sub">The agent is waiting. Press Resume when you're signed in.</div>
            </>
          )}
        </div>
        <button type="button" class="fc-primary" ref={doneBtn} disabled={busy} onClick={() => void done()}>
          <PlayIcon />
          Done, resume task
        </button>
        <button type="button" class="fc-ctl-tool" aria-label="Close the panel" onClick={() => leaveRef.current(false)}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      </header>
      {err ? <p class="fc-err fc-ctl-err" role="alert">{err}</p> : null}
      {sendErr && !err ? <p class="fc-err fc-ctl-err" role="status">{SEND_FAILED_NOTE}</p> : null}
      <div class="fc-ctl-bar">
        <span class="fc-ctl-site">{shown ?? ''}</span>
        <button type="button" class="fc-secondary fc-ctl-paste" aria-expanded={pasteOpen} onClick={() => setPasteOpen((o) => !o)}>
          Paste
        </button>
      </div>
      {pasteOpen ? (
        <form class="fc-ctl-pasteform" onSubmit={sendPaste}>
          <label class="fc-ctl-pastelabel">
            Text to paste
            <input
              ref={pasteField} type="password" class="fc-txt" autocomplete="new-password" value={pasteText}
              onInput={(e) => setPasteText((e.target as HTMLInputElement).value)}
            />
          </label>
          <button type="submit" class="fc-primary" disabled={!pasteText}>Send</button>
        </form>
      ) : null}
      <BrowserStage
        api={api}
        mode="control"
        label={shown ? `Interactive view of the task’s browser on ${shown}` : 'Interactive view of the task’s browser'}
        stageClass="fc-ctl-stage"
        stageStyle={style}
        stageRef={stage}
        canvasRef={canvas}
        canvasProps={canvasProps}
        onFrame={(f: BrowserFrame | null) => {
          if (!f) return;
          frame.current = { w: f.w, h: f.h };
          if (f.site && f.site !== frameSite) setFrameSite(f.site);
        }}
      />
      <p class="fc-ctl-foot" id={hintId}>
        {CONTROL_HINT} <kbd class="fc-ctl-esc">{ESC_HINT}</kbd>
      </p>
    </section>
  );
}
