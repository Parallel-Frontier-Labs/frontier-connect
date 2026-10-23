// Real-browser smoke test for the three file viewers and the sandboxed HTML frame.
// Usage: PLAYWRIGHT_DIR=<.../node_modules/playwright> node scripts/preview-smoke.mjs   (run `npm run build` first)
//
// The card's staticBase() demands https, so this harness does NOT go through it: it injects the built
// viewer scripts straight from a loopback server by URL. It checks the bundles and the frame, not staticBase.
// The card page is served under a host-like CSP header without 'unsafe-eval' (see hostCsp), and the frame's
// navigation is checked against a loopback leak server.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import JSZip from 'jszip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pwDir = process.env.PLAYWRIGHT_DIR;
if (!pwDir) throw new Error('PLAYWRIGHT_DIR is required');
const pw = (await import(pathToFileURL(path.join(pwDir, 'index.js')).href)).default;
const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'static', 'manifest.json'), 'utf8'));

// frame.ts bundled to a temp ESM file so node can import it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-smoke-'));
await build({ entryPoints: [path.join(root, 'app/src/preview/frame.ts')], outfile: path.join(tmp, 'frame.mjs'), bundle: true, format: 'esm', logLevel: 'silent' });
const { framedHtml, FRAME_SANDBOX } = await import(pathToFileURL(path.join(tmp, 'frame.mjs')).href);

const fail = (m) => { throw new Error(m); };

// Fixtures.
const xlsxBytes = [...fs.readFileSync(path.join(root, 'app/test/fixtures/sample.xlsx'))];
// One JPEG 2000 image (/Filter /JPXDecode): pdf.js decodes it only with WebAssembly, which hostCsp refuses.
const jpxBytes = [...fs.readFileSync(path.join(root, 'app/test/fixtures/jpx.pdf'))];
// The same image behind an indirect /Filter inside an object stream: no JPXDecode token in the raw bytes.
const jpxIndirectBytes = [...fs.readFileSync(path.join(root, 'app/test/fixtures/jpx-indirect.pdf'))];
const pdfBytes = (() => {
  const content = '0 0 0 rg 20 20 160 160 re f BT /F1 24 Tf 30 100 Td (Hello) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return [...Buffer.from(out, 'latin1')];
})();
const docxBytes = await (async () => {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Quarterly memo</w:t></w:r></w:p></w:body></w:document>');
  return [...(await z.generateAsync({ type: 'uint8array' }))];
})();

const dashboard = `<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head>
<body><img src="https://example.com/x.png"><script>
var net='unknown';
fetch('https://example.com/').then(function(){net='open'},function(){net='blocked'}).then(function(){
  parent.postMessage({script:true,mode:document.compatMode,net:net,rtc:typeof RTCPeerConnection},'*');
});
</script></body></html>`;

// The card's own policy (app/index.html): no frame it holds may navigate.
const FRAME_SRC_META = `<meta http-equiv="Content-Security-Policy" content="frame-src 'none'">`;

// Leak server: records every request, so a framed page that navigates out with a nonce is caught.
const leaks = [];
const leakServer = http.createServer((req, res) => { leaks.push(req.url); res.writeHead(204); res.end(); });
await new Promise((r) => leakServer.listen(0, '127.0.0.1', r));
const leakBase = `http://127.0.0.1:${leakServer.address().port}`;

// A framed page per way out: assigning location, a meta refresh, and a clicked link. Each posts first,
// so the harness knows its script ran, then tries to leave with the nonce in the URL.
const navPages = (nonce) => {
  const to = (via) => `${leakBase}/leak?d=${nonce}&via=${via}`;
  const ran = (via) => `<script>parent.postMessage({nav:'${via}'},'*')</script>`;
  return {
    href: `<!doctype html><html><body>${ran('href')}<script>location.href='${to('href')}'</script></body></html>`,
    refresh: `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${to('refresh')}"></head><body>${ran('refresh')}</body></html>`,
    link: `<!doctype html><html><body>${ran('link')}<script>var a=document.createElement('a');a.href='${to('link')}';document.body.appendChild(a);a.click()</script></body></html>`,
  };
};

// A host-like policy on the card page: no eval, so the viewers are proven to run without it.
const hostCsp = (origin) => `default-src 'none'; script-src 'self' 'unsafe-inline' ${origin}; style-src 'unsafe-inline'; font-src ${origin}; connect-src ${origin}; img-src data: blob:; frame-src 'none'`;

// Loopback server: /static/* from dist/static, /card.html with the static base replaced, served under hostCsp.
// ?header=off drops that header (the card's own meta alone); ?meta=off strips the card's frame-src
// (with header=off, the control: there the leaks must get through).
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (url.pathname === '/card.html') {
    let html = fs.readFileSync(path.join(dist, 'task-card.html'), 'utf8').replaceAll('__FRONTIER_STATIC__', `${origin}/static`);
    if (html.split(FRAME_SRC_META).length !== 2) { res.writeHead(500); res.end('card lacks its frame-src meta'); return; }
    if (url.searchParams.get('meta') === 'off') html = html.replace(FRAME_SRC_META, '');
    const headers = { 'content-type': 'text/html' };
    if (url.searchParams.get('header') !== 'off') headers['content-security-policy'] = hostCsp(origin);
    res.writeHead(200, headers); res.end(html); return;
  }
  if (url.pathname.startsWith('/static/')) {
    const f = path.join(dist, 'static', path.basename(url.pathname));
    if (fs.existsSync(f)) { res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }); res.end(fs.readFileSync(f)); return; }
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const results = {};
try {
  const page = await browser.newPage();
  const failed = [];
  const responses = [];
  page.on('requestfailed', (r) => failed.push({ url: r.url(), err: r.failure()?.errorText ?? '' }));
  page.on('response', (r) => responses.push(r.url()));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const card = await page.goto(`${base}/card.html`);
  if (card.headers()['content-security-policy'] !== hostCsp(base)) fail('card page not served under the host-like CSP');
  // Every policy violation in the card's own document (an eval, a wasm compile, a blocked load).
  await page.evaluate(() => { window.__violations = []; addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective} ${e.blockedURI}`)); });
  // Code called straight from page.evaluate may eval even under a CSP (DevTools-originated stack), so every
  // viewer call below first yields to a page task. The control: from such a task, eval is refused and reported.
  const evalHere = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 0));
    try { eval('1'); return 'ran'; } catch { return 'refused'; }
  });
  const evalSeen = await page.evaluate(() => window.__violations.splice(0));
  if (evalHere !== 'refused' || !evalSeen.some((v) => v.startsWith('script-src'))) fail(`host-like CSP not enforced: eval ${evalHere}, ${evalSeen}`);
  const inject = (name) => page.addScriptTag({ url: `${base}/static/${manifest[name]}` });

  await inject('viewer-sheet');
  const sheets = await page.evaluate(async (b) => { await new Promise((r) => setTimeout(r, 0)); return window.__frontierViewers.sheet.parse(new Uint8Array(b)); }, xlsxBytes);
  if (sheets.length !== 2 || sheets[0].name !== 'Holdings' || sheets[0].rows[1][0] !== 'VTV') fail(`sheet: ${JSON.stringify(sheets)}`);
  results.sheet = 'ok';

  await inject('viewer-pdf');
  const dark = await page.evaluate(async (b) => {
    await new Promise((r) => setTimeout(r, 0));
    const doc = await window.__frontierViewers.pdf.open(new Uint8Array(b));
    const c = document.createElement('canvas');
    const r = await doc.render(1, c, 200);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) n++;
    await doc.destroy();
    return { n, missing: r.missingImages };
  }, pdfBytes);
  if (!(dark.n > 100)) fail(`pdf: only ${dark.n} dark px`);
  if (dark.missing !== false) fail(`pdf plain: missingImages ${dark.missing}`);
  results.pdf = `ok (${dark.n} dark px)`;

  await inject('viewer-docx');
  const html = await page.evaluate(async (b) => { await new Promise((r) => setTimeout(r, 0)); return window.__frontierViewers.docx.toHtml(new Uint8Array(b)); }, docxBytes);
  if (!html.includes('Quarterly memo')) fail(`docx: ${html}`);
  results.docx = 'ok';
  const violations = await page.evaluate(() => window.__violations);
  if (violations.length) fail(`viewers under the host-like CSP: ${violations}`);

  // JPEG 2000 under a policy without 'wasm-unsafe-eval': the viewer says images are missing, and the page
  // still renders. The only violations allowed here are the refused WebAssembly compiles.
  const jpxCase = (b) => page.evaluate(async (bytes) => {
    await new Promise((r) => setTimeout(r, 0));
    const doc = await window.__frontierViewers.pdf.open(new Uint8Array(bytes));
    const c = document.createElement('canvas');
    let rendered = 'ok';
    let missingImages;
    try { missingImages = (await doc.render(1, c, 200)).missingImages; } catch (e) { rendered = String(e); }
    const pages = doc.pages;
    await doc.destroy();
    return { missingImages, pages, rendered };
  }, b);
  const jpxViolations = [];
  for (const [name, bytes] of [['plain', jpxBytes], ['indirect', jpxIndirectBytes]]) {
    const jpx = await jpxCase(bytes);
    if (jpx.missingImages !== true || jpx.pages !== 1 || jpx.rendered !== 'ok') fail(`pdf jpx ${name}: ${JSON.stringify(jpx)}`);
    jpxViolations.push(...await page.evaluate(() => window.__violations.splice(0)));
  }
  if (!jpxViolations.length || jpxViolations.some((v) => !/wasm/.test(v))) fail(`pdf jpx: violations ${jpxViolations}`);
  results.jpx = `plain + indirect filter: missingImages after render, ${jpxViolations.length} wasm refusals`;

  // HTML frame.
  const seen = await page.evaluate(({ srcdoc, sandbox }) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no message from frame')), 8000);
    addEventListener('message', (e) => { if (e.data && e.data.script) { clearTimeout(t); resolve(e.data); } });
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', sandbox);
    f.srcdoc = srcdoc;
    document.body.appendChild(f);
  }), { srcdoc: framedHtml(dashboard), sandbox: FRAME_SANDBOX });
  await page.waitForTimeout(500);
  if (seen.script !== true || seen.mode !== 'CSS1Compat' || seen.net !== 'blocked') fail(`html: ${JSON.stringify(seen)}`);
  if (seen.rtc !== 'undefined') fail(`html: RTCPeerConnection is ${seen.rtc}`);
  // The font link and the image are refused by the CSP: Chromium reports either a requestfailed (csp) or, when
  // it refuses before creating the request (as under the card's own policy), a "Refused to load" console error.
  // A CSP-blocked fetch() never leaves the page; it is covered by net:'blocked' above and the no-response check below.
  for (const u of ['https://fonts.googleapis.com/css2?family=Inter', 'https://example.com/x.png']) {
    const f = failed.find((x) => x.url === u);
    const refused = consoleErrors.some((m) => m.startsWith('Refused to load') && m.includes(`'${u}'`));
    if (!(f && /csp/i.test(f.err)) && !refused) fail(`html: ${u} not refused by the csp: ${JSON.stringify({ failed, consoleErrors })}`);
  }
  const outside = responses.filter((u) => !u.startsWith('data:') && !u.startsWith(base));
  if (outside.length) fail(`html: outside responses ${outside}`);
  results.html = 'ok';
  if (errors.length) fail(`page errors: ${errors}`);

  // Navigation: three framed pages try to leave with a nonce. Under the card's frame-src none reach the
  // leak server and each still runs its script; the control (meta stripped) shows the harness sees leaks.
  const navRun = async (cardUrl) => {
    const nonce = crypto.randomUUID();
    const p = await browser.newPage();
    try {
      const r = await p.goto(cardUrl);
      if (r.status() !== 200) fail(`nav: ${cardUrl} ${r.status()}`);
      const ran = await p.evaluate(({ pages, sandbox, framed }) => new Promise((resolve) => {
        const seen = new Set();
        const t = setTimeout(() => resolve([...seen]), 8000);
        addEventListener('message', (e) => {
          if (e.data && e.data.nav) seen.add(e.data.nav);
          if (seen.size === Object.keys(pages).length) { clearTimeout(t); resolve([...seen]); }
        });
        for (const k of Object.keys(pages)) {
          const f = document.createElement('iframe');
          f.setAttribute('sandbox', sandbox);
          f.srcdoc = framed[k];
          document.body.appendChild(f);
        }
      }), { pages: navPages(nonce), sandbox: FRAME_SANDBOX, framed: Object.fromEntries(Object.entries(navPages(nonce)).map(([k, v]) => [k, framedHtml(v)])) });
      await p.waitForTimeout(2000);
      const hit = leaks.filter((u) => u.includes(nonce)).map((u) => new URL(u, leakBase).searchParams.get('via'));
      return { ran: ran.sort(), hit: [...new Set(hit)].sort() };
    } finally {
      await p.close();
    }
  };
  const ways = ['href', 'link', 'refresh'];
  const control = await navRun(`${base}/card.html?meta=off&header=off`);
  if (control.hit.join() !== ways.join()) fail(`nav control: expected every way to leak without frame-src, got ${JSON.stringify(control)}`);
  // The card's meta alone, then under the host-like header too.
  for (const q of ['?header=off', '']) {
    const guarded = await navRun(`${base}/card.html${q}`);
    if (guarded.ran.join() !== ways.join()) fail(`nav${q}: framed scripts did not all run: ${JSON.stringify(guarded)}`);
    if (guarded.hit.length) fail(`nav${q}: leaked via ${guarded.hit}`);
  }
  results.nav = 'ok';

  console.log(`preview smoke: sheet ${results.sheet}, pdf ${results.pdf}, pdf jpx ok (${results.jpx}), docx ${results.docx}, html ${results.html} (script, CSS1Compat, net blocked, RTCPeerConnection undefined), nav ${results.nav} (href, refresh, link blocked by frame-src; control leaked all 3); card under host-like CSP (eval refused), viewers 0 violations`);
} catch (e) {
  console.error('preview smoke FAILED:', e.message, results);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  leakServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
