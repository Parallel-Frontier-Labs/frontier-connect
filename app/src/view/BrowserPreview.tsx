import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { BrowserFrame, ControlOutcome, FeedMode, FeedStatus } from '../browserFeed';
import type { BrowserInput, SendOutcome } from '../browserInput';

/** The part of BrowserFeed a view drives. */
export interface FeedHandle {
  start(): void;
  stop(): void;
  setMode(m: FeedMode): void;
  setVisible(v: boolean): void;
  wake(): void;
}

/** What the card needs to show the task's browser (Root builds it from the bridge and the Poller). */
export interface BrowserApi {
  /** Display modes the host offers (undefined when it does not say). */
  modes: readonly string[] | undefined;
  /** The display mode the card is shown in now ('inline' when the host does not say). */
  mode: string;
  /** A frame feed for one view, or null when the card cannot read frames at all. */
  feed(onFrame: (f: BrowserFrame | null) => void, onStatus?: (s: FeedStatus) => void): FeedHandle | null;
  /** Ask the host for a display mode; resolves with the mode it applied. */
  requestDisplayMode(mode: 'inline' | 'fullscreen'): Promise<string>;
  /** Send input events to the task's browser, in order, as one request (the control view).
   * Absent: no control view. */
  input?(taskId: string, events: BrowserInput[]): Promise<SendOutcome>;
  /** Ask the server to pause the agent so the user can drive (Take control). Absent: watch only. */
  control?(taskId: string): Promise<ControlOutcome>;
  /** How the card reaches the server: 'direct' (frames and input work); 'reconnecting' (a direct
   * read failed but worked before on this card: retried every 30 s); 'blocked' (the host never
   * let the card reach the server directly: the browser cannot be controlled from here). */
  transport?(): Transport;
  /** Read the task again now (after the user resumed or stopped it). */
  refresh?(): void;
  /** The host's container size (for the inline control view's height). */
  container?(): { height?: number; maxHeight?: number } | undefined;
  /** Stop the task from the card (true when the server took it). Absent when the host does not
   * forward the card's tool calls. */
  stop?(): Promise<boolean>;
}

export type Transport = 'direct' | 'reconnecting' | 'blocked';

type Source = CanvasImageSource & { close?: () => void };

/** The canvas backing store is at most this many pixels on its long edge (the frame is scaled). */
export const MAX_CANVAS_EDGE = 2048;

/** Canvas size for a w×h frame: the same aspect, the long edge at most MAX_CANVAS_EDGE. */
export function canvasSize(w: number, h: number): { w: number; h: number } {
  const k = Math.min(1, MAX_CANVAS_EDGE / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Decode a base64 JPEG: an ImageBitmap from a Blob where available, else an Image from a data URL.
 * Async, so bad base64 (atob throws) becomes a rejection, never a throw into the feed. */
async function decode(data: string): Promise<Source> {
  if (typeof createImageBitmap === 'function') {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = `data:image/jpeg;base64,${data}`;
  });
}

/**
 * The browser's picture: a canvas painted from the feed, letterboxed to the frame's aspect inside a
 * 16:10 box. Owns the feed for as long as it is mounted, pauses it while out of view or while the
 * page is hidden, and drops a frame that finishes decoding after a newer one.
 */
export function BrowserStage({
  api,
  mode = 'preview',
  label,
  onFrame,
  onStatus,
  onPainted,
  stageClass,
  stageStyle,
  stageRef,
  canvasRef,
  canvasProps,
}: {
  api: BrowserApi;
  mode?: FeedMode;
  /** Accessible name of the picture. */
  label: string;
  /** Every frame the feed delivers (null when the server has none), before it is painted. */
  onFrame?: (f: BrowserFrame | null) => void;
  /** The feed's status changed. */
  onStatus?: (s: FeedStatus) => void;
  /** A picture is on screen (true) or not (false: no frame yet, an empty answer, unavailable). */
  onPainted?: (painted: boolean) => void;
  /** Extra class on the stage box (the control view fills its space instead of 16:10). */
  stageClass?: string;
  stageStyle?: JSX.CSSProperties;
  stageRef?: { current: HTMLDivElement | null };
  canvasRef?: { current: HTMLCanvasElement | null };
  /** Extra canvas attributes and handlers (the control view's input). */
  canvasProps?: JSX.HTMLAttributes<HTMLCanvasElement>;
}) {
  const ownBox = useRef<HTMLDivElement>(null);
  const ownCanvas = useRef<HTMLCanvasElement>(null);
  const box = stageRef ?? ownBox;
  const canvas = canvasRef ?? ownCanvas;
  const feed = useRef<FeedHandle | null>(null);
  const latest = useRef(0);
  const frameCb = useRef(onFrame);
  frameCb.current = onFrame;
  const onStatusCb = useRef(onStatus);
  onStatusCb.current = onStatus;
  const [painted, setPainted] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    const paint = (f: BrowserFrame | null) => {
      const ticket = ++latest.current;
      frameCb.current?.(f);
      if (!f) {
        setPainted(false);
        return;
      }
      decode(f.data).then(
        (src) => {
          try {
            const c = canvas.current;
            if (!live || ticket !== latest.current || !c) return;
            const size = canvasSize(f.w, f.h);
            if (c.width !== size.w) c.width = size.w;
            if (c.height !== size.h) c.height = size.h;
            c.getContext('2d')?.drawImage(src, 0, 0, size.w, size.h);
            setPainted(true);
          } catch {
            /* a frame that does not paint is skipped */
          } finally {
            src.close?.();
          }
        },
        () => {
          /* a frame that does not decode is skipped */
        },
      );
    };
    const h = api.feed(paint, (st) => {
      if (!live) return;
      setUnavailable(st !== 'ok');
      onStatusCb.current?.(st);
    });
    feed.current = h;
    if (!h) setUnavailable(true);
    h?.setMode(mode);
    h?.start();
    let io: IntersectionObserver | null = null;
    if (h && box.current && typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver((entries) => {
        const e = entries[entries.length - 1];
        if (e) h.setVisible(e.isIntersecting);
      });
      io.observe(box.current);
    }
    const onVis = () => h?.wake();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVis);
      io?.disconnect();
      h?.stop();
      feed.current = null;
    };
  }, []);

  useEffect(() => {
    feed.current?.setMode(mode);
  }, [mode]);

  const showing = painted && !unavailable;
  const paintedCb = useRef(onPainted);
  paintedCb.current = onPainted;
  useEffect(() => {
    paintedCb.current?.(showing);
  }, [showing]);

  const note = unavailable ? 'The live preview is not available in this app.' : painted ? null : 'Waiting for the browser…';
  return (
    <div class={stageClass ? `fc-bv-stage ${stageClass}` : 'fc-bv-stage'} style={stageStyle} ref={box}>
      <canvas role="img" aria-label={label} {...canvasProps} ref={canvas} class={showing ? 'fc-bv-canvas' : 'fc-bv-canvas fc-bv-hidden'} />
      {note ? <p class="fc-bv-wait">{note}</p> : null}
    </div>
  );
}

export function ExpandIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
      <path d="M8.5 1.5h4v4M5.5 12.5h-4v-4M12.5 1.5L8 6M1.5 12.5L6 8" />
    </svg>
  );
}

export const FULLSCREEN_REFUSED = 'This app kept the card in the chat.';
export const DRIVING = 'Frontier is driving';
export const TAKE_CONTROL = 'Take control';
export const PAUSING = 'Pausing the agent…';
export const WATCH_HINT = 'Watch only. Press Take control to drive.';
export const CONTROL_MISSED = 'The agent finished this browser step before it could pause.';
export const CONTROL_FAILED = "Couldn't send that. Try again.";
export const WATCH_BLOCKED = 'Watch only in this app. Open the task in Frontier to drive.';
/** How long a click on the watch-only canvas shows the hint. */
export const WATCH_HINT_MS = 3000;

/** Where a Take control press stands: none, waiting for the pause, the step ended first, or the
 * request failed. The card owns it (the pause lands after the preview is gone). */
export type ControlPhase = 'idle' | 'pausing' | 'missed' | 'failed';

/** Watching the agent drive the task's browser (design boards 1 and 4): Live, the site, "Frontier
 * is driving", Take control and Full screen. The header says "Connecting" until a picture is on
 * screen (and after an empty answer), and "Paused" while the preview is unavailable. The header
 * carries the watch-only wording, so full screen shows it too. */
export function BrowserPreview({
  site,
  api,
  control,
}: {
  site: string | null;
  api: BrowserApi;
  /** Take control (the card passes it while the agent drives). Shown only when the api can ask
   * for control and the host lets the card reach the server. */
  control?: { phase: ControlPhase; onPress: () => void };
}) {
  const [frameSite, setFrameSite] = useState<string | null>(null);
  const [showing, setShowing] = useState(false);
  const [status, setStatus] = useState<FeedStatus>('ok');
  const [refused, setRefused] = useState(false);
  const [hint, setHint] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);
  const shown = frameSite ?? site;
  const canFull = !!api.modes?.includes('fullscreen') && api.mode !== 'fullscreen';
  const blocked = api.transport?.() === 'blocked';
  const canControl = !!control && !!api.control && !blocked;
  const pausing = control?.phase === 'pausing';
  const full = async () => {
    setRefused(false);
    const applied = await api.requestDisplayMode('fullscreen');
    if (alive.current) setRefused(applied !== 'fullscreen');
  };
  // A click on the watch-only picture says how to drive (people expect it to be interactive).
  const flashHint = () => {
    if (!canControl) return;
    setHint(true);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(false), WATCH_HINT_MS);
  };
  return (
    <div class="fc-bv">
      <section class="fc-bv-box" aria-label="Browser, live">
        <div class="fc-bv-bar">
          <span class={showing ? 'fc-bv-live' : 'fc-bv-live fc-bv-paused'}>
            <span class="fc-bv-dot" aria-hidden="true" />
            {showing ? 'Live' : status !== 'ok' ? 'Paused' : 'Connecting'}
          </span>
          <span class="fc-bv-site">{shown ?? ''}</span>
          <span class="fc-bv-who">{DRIVING}</span>
          {canControl ? (
            <button type="button" class="fc-bv-btn fc-bv-ctl" disabled={pausing} onClick={control!.onPress}>
              {pausing ? PAUSING : TAKE_CONTROL}
            </button>
          ) : null}
          {canFull ? (
            <button type="button" class="fc-bv-btn" aria-label="Open the browser full screen" onClick={() => void full()}>
              <ExpandIcon />
              Full screen
            </button>
          ) : null}
        </div>
        {blocked ? <p class="fc-bv-note">{WATCH_BLOCKED}</p> : null}
        <BrowserStage
          api={api}
          label={shown ? `Live view of the task’s browser on ${shown}` : 'Live view of the task’s browser'}
          stageClass="fc-bv-watch"
          canvasProps={{ onClick: flashHint }}
          onFrame={(f) => {
            if (f?.site && f.site !== frameSite) setFrameSite(f.site);
          }}
          onPainted={setShowing}
          onStatus={setStatus}
        />
      </section>
      {refused ? <p class="fc-bv-cap" role="status">{FULLSCREEN_REFUSED}</p> : null}
      {hint && !pausing ? <p class="fc-bv-cap" role="status">{WATCH_HINT}</p> : null}
      {control?.phase === 'missed' ? <p class="fc-bv-cap" role="status">{CONTROL_MISSED}</p> : null}
      {control?.phase === 'failed' ? <p class="fc-bv-cap fc-bv-err" role="status">{CONTROL_FAILED}</p> : null}
    </div>
  );
}
