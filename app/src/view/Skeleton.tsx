export type SkeletonKind = 'task' | 'list' | 'add';

/** The view a tool's card will show, so the skeleton has its shape and roughly its height. */
export function skeletonKind(tool: string | undefined): SkeletonKind {
  if (tool === 'frontier_list_tasks') return 'list';
  if (tool === 'frontier_add_files') return 'add';
  return 'task';
}

const Bar = ({ w, h = 10 }: { w: string; h?: number }) => <span class="fc-skel-bar" style={{ width: w, height: `${h}px` }} />;

/**
 * Shown from the card's first paint until the result and the fonts are both in. It holds a fixed,
 * view-sized height (card.css), so the host sizes its frame once here and once at the swap, instead
 * of shrinking to one line of "Loading…" and jumping when the card arrives. No text, so nothing
 * re-wraps when the fonts land.
 */
export function Skeleton({ kind, theme }: { kind: SkeletonKind; theme: 'light' | 'dark' }) {
  const rows = kind === 'list' ? 2 : 0;
  return (
    <div class={`fc-skel fc-skel-${kind}`} data-theme={theme} role="status" aria-busy="true">
      <span class="fc-sr">{kind === 'list' ? 'Loading your tasks…' : 'Loading the task…'}</span>
      <div class="fc-skel-head" aria-hidden="true">
        <span class="fc-skel-mark" />
        <span class="fc-skel-titles"><Bar w="46%" h={12} /><Bar w="28%" h={8} /></span>
        <span class="fc-skel-pill" />
      </div>
      <div class="fc-skel-body" aria-hidden="true">
        {kind === 'list' ? (
          <>
            <span class="fc-skel-chips"><span /><span /><span /></span>
            {Array.from({ length: rows }, (_, i) => (
              <span class="fc-skel-row" key={i}><Bar w={`${58 - i * 6}%`} h={11} /><Bar w="34%" h={8} /></span>
            ))}
          </>
        ) : kind === 'add' ? (
          <>
            <Bar w="80%" h={12} />
            <span class="fc-skel-box fc-skel-drop" />
            <Bar w="30%" h={10} />
          </>
        ) : (
          <>
            <Bar w="92%" h={12} />
            <Bar w="70%" h={12} />
            <span class="fc-skel-box" />
            <Bar w="22%" h={10} />
          </>
        )}
      </div>
      <div class="fc-skel-foot" aria-hidden="true"><Bar w="12%" h={8} /></div>
    </div>
  );
}
