const TAGS = new Set(['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
  'a', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'blockquote', 'pre', 'code', 'span', 'div', 'hr']);
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'svg', 'math', 'template', 'form', 'input', 'button']);

/** An allow-list copy of `html`: known tags only, no attributes but https links and data: images. */
export function sanitizeHtml(html: string, doc: Document = document): string {
  const src = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  const out = doc.createElement('div');
  const copy = (from: Node, to: Node) => {
    for (const n of Array.from(from.childNodes)) {
      if (n.nodeType === 3) { to.appendChild(doc.createTextNode(n.textContent ?? '')); continue; }
      if (n.nodeType !== 1) continue;
      const el = n as Element;
      const tag = el.tagName.toLowerCase();
      if (DROP.has(tag)) continue;
      if (!TAGS.has(tag)) { copy(el, to); continue; }
      if (tag === 'img') {
        const s = el.getAttribute('src') ?? '';
        if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) { const img = doc.createElement('img'); img.setAttribute('src', s); to.appendChild(img); }
        continue;
      }
      const clean = doc.createElement(tag);
      if (tag === 'a') {
        const h = el.getAttribute('href') ?? '';
        if (/^https:\/\//i.test(h)) { clean.setAttribute('href', h); clean.setAttribute('rel', 'noopener noreferrer'); clean.setAttribute('target', '_blank'); }
      }
      to.appendChild(clean);
      copy(el, clean);
    }
  };
  copy(src, out);
  return out.innerHTML;
}
