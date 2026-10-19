import type { ComponentChildren } from 'preact';

/**
 * A deliberately small markdown renderer for task summaries. It builds Preact nodes and never
 * touches innerHTML, so nothing in the text can become markup. Supported: paragraphs, `#`-`###`
 * headings (styled block text, not h1-h3, so they never compete with the card title), **bold**,
 * *italic* / _italic_, `code`, `-` `*` `+` bullets and `1.` numbered lists. A link renders as its
 * text only; images, HTML tags and every other construct render as literal text. Unbalanced
 * markers stay literal.
 */

const MAX_DEPTH = 4;
const IMAGE = /^!\[[^\]]*\]\([^)]*\)/;
const LINK = /^\[([^\]]*)\]\(([^)\s]*)\)/;
const WORD = /[A-Za-z0-9]/;

export function renderInline(src: string, depth = 0): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const noCloser = new Set<string>(); // a marker with no closer after some point has none later either
  // Valid `_` closers (end a word, no space before), found lazily once; `i` only moves forward.
  let under: number[] | null = null;
  let upos = 0;
  const underCloser = (from: number): number => {
    if (!under) {
      under = [];
      for (let k = 0; k < src.length; k++) {
        if (src[k] === '_' && k > 0 && !/\s/.test(src[k - 1]!) && !WORD.test(src[k + 1] ?? '')) under.push(k);
      }
    }
    while (upos < under.length && under[upos]! < from) upos++;
    return upos < under.length ? under[upos]! : -1;
  };
  let buf = '';
  let key = 0;
  const flush = () => {
    if (buf) out.push(buf);
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '`') {
      const end = noCloser.has('`') ? -1 : src.indexOf('`', i + 1);
      if (end === -1) noCloser.add('`');
      else if (end > i + 1) {
        flush();
        out.push(<code key={key++}>{src.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    } else if (c === '!' && src[i + 1] === '[') {
      const m = IMAGE.exec(src.slice(i, i + 2000));
      if (m) {
        buf += m[0];
        i += m[0].length;
        continue;
      }
    } else if (c === '[') {
      const m = LINK.exec(src.slice(i, i + 2000));
      if (m) {
        flush();
        out.push(...(depth < MAX_DEPTH ? renderInline(m[1]!, depth + 1) : [m[1]!]));
        i += m[0].length;
        continue;
      }
    } else if ((c === '*' || c === '_') && depth < MAX_DEPTH) {
      const strong = c === '*' && src[i + 1] === '*';
      const mark = strong ? '**' : c;
      const opens = strong || c === '*' || !(i > 0 && WORD.test(src[i - 1]!));
      const after = src[i + mark.length];
      if (opens && after !== undefined && !/\s/.test(after) && !noCloser.has(mark)) {
        // An underscore closer must end a word, so snake_case never turns italic.
        const end = c === '_' ? underCloser(i + 1) : src.indexOf(mark, i + mark.length);
        if (end === -1) noCloser.add(mark);
        else if (end > i + mark.length && !/\s/.test(src[end - 1]!)) {
          flush();
          const inner = renderInline(src.slice(i + mark.length, end), depth + 1);
          out.push(strong ? <strong key={key++}>{inner}</strong> : <em key={key++}>{inner}</em>);
          i = end + mark.length;
          continue;
        }
      }
      // Unmatched: the whole marker run is literal.
      buf += mark;
      i += mark.length;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

type Block =
  | { t: 'h'; level: 1 | 2 | 3; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: string[] };

// No lazy quantifier before optional trailers (that backtracks cubically); the closing # run is stripped in code.
const HEADING = /^(#{1,3})[ \t]+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*\d{1,9}[.)]\s+(.*)$/;

/** Drop a closing run of `#` (and the spaces around it) from a heading, in linear time. */
function stripClosing(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  let k = end;
  while (k > 0 && text[k - 1] === '#') k--;
  if (k < end && (k === 0 || text[k - 1] === ' ' || text[k - 1] === '\t')) end = k;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  return text.slice(0, end).replace(/^[ \t]+/, '');
}

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ t: 'p', text: para.join('\n') });
    para = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) {
      endPara();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      endPara();
      blocks.push({ t: 'h', level: h[1]!.length as 1 | 2 | 3, text: stripClosing(h[2]!) });
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBER.exec(line);
    if (b || n) {
      endPara();
      const t = b ? 'ul' : 'ol';
      const last = blocks[blocks.length - 1];
      if (last && last.t === t) last.items.push((b ?? n)![1]!);
      else blocks.push({ t, items: [(b ?? n)![1]!] });
      continue;
    }
    const last = blocks[blocks.length - 1];
    // A non-list line right after a list item continues that item.
    if (!para.length && last && (last.t === 'ul' || last.t === 'ol') && /^\s/.test(line)) {
      last.items[last.items.length - 1] += ' ' + line.trim();
      continue;
    }
    para.push(line);
  }
  endPara();
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  if (!blocks.length) return null;
  return (
    <div class="fc-md">
      {blocks.map((b, i) => {
        if (b.t === 'h') return <p key={i} class={`fc-md-h fc-md-h${b.level}`}>{renderInline(b.text)}</p>;
        if (b.t === 'p') return <p key={i} class="fc-md-p">{renderInline(b.text)}</p>;
        const items = b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>);
        return b.t === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>;
      })}
    </div>
  );
}
