import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const common = { absWorkingDir: root, bundle: true, minify: true, write: false, logLevel: 'warning' };

// The host SDK pulls in zod, which is far larger than the card needs when bundled whole.
// Trim what the card never uses: every non-English locale (~300 KB minified), the optional
// JIT schema compiler and the JSON-Schema-to-zod converter. The card only validates host
// messages with the default parser, so these paths are never reached.
const zodDir = String.raw`zod[\\/]v4[\\/]`;
const stubs = [
  [new RegExp(zodDir + String.raw`locales[\\/]index\.js$`), `export { default as en } from './en.js';`],
  [
    new RegExp(zodDir + String.raw`core[\\/]compile\.js$`),
    `export const INVALID = Symbol.for('zod.compile.invalid');
export class ZodCompileAsyncError extends Error {}
export class ZodCompileUnsupportedError extends Error {}
const off = () => { throw new Error('schema compiler is not bundled in the task card'); };
export const compile = off, withParser = off, compileFn = off;`,
  ],
  [
    new RegExp(zodDir + String.raw`classic[\\/]from-json-schema\.js$`),
    `export const fromJSONSchema = () => { throw new Error('not bundled in the task card'); };`,
  ],
  // JSON Schema export is a server-side concern; the card never asks a schema for its JSON form.
  [new RegExp(zodDir + String.raw`core[\\/]json-schema-processors\.js$`), `export const allProcessors = {}, toJSONSchema = () => { throw new Error("not bundled in the task card"); };`],
  [
    new RegExp(zodDir + String.raw`core[\\/]to-json-schema\.js$`),
    `const off = () => { throw new Error('JSON Schema export is not bundled in the task card'); };
export const createToJSONSchemaMethod = () => off, createStandardJSONSchemaMethod = () => off;
export const extractDefs = off, finalize = off, initializeContext = off, processSchema = off, handleUnrepresentable = off;`,
  ],
];
const trimZod = {
  name: 'trim-zod',
  setup(b) {
    for (const [filter, contents] of stubs) {
      b.onLoad({ filter }, (a) => ({ contents, resolveDir: dirname(a.path), loader: 'js' }));
    }
    // zod probes the user agent of one hosting platform before enabling its JIT path. The card
    // never uses the JIT path, so drop the probe (and the vendor name it embeds) from the bundle.
    b.onLoad({ filter: new RegExp(zodDir + String.raw`core[\\/]util\.js$`) }, (a) => {
      const src = readFileSync(a.path, 'utf8');
      const probe = /navigator\?\.userAgent\?\.includes\("[A-Za-z]+"\)/;
      if (!probe.test(src)) throw new Error('trim-zod: the user-agent probe moved; update scripts/build.mjs');
      return { contents: src.replace(probe, 'false'), resolveDir: dirname(a.path), loader: 'js' };
    });
  },
};

const css = await build({ ...common, entryPoints: ['app/src/card.css'] });

// Fonts are separate hashed files in dist/static, loaded from the static base the serving side
// fills in (see app/src/staticBase.ts): Public Sans 400/600/700 and IBM Plex
// Mono 400, latin subset, woff2, from the @fontsource packages. They are under the SIL Open Font
// License 1.1, which every copy must carry: LICENSES/OFL-1.1.txt (the copyright lines and the
// license text, verbatim) is written in full into a comment next to the faces.
const FONTS = [
  ['Public Sans', 400, '@fontsource/public-sans/files/public-sans-latin-400-normal.woff2'],
  ['Public Sans', 600, '@fontsource/public-sans/files/public-sans-latin-600-normal.woff2'],
  ['Public Sans', 700, '@fontsource/public-sans/files/public-sans-latin-700-normal.woff2'],
  ['IBM Plex Mono', 400, '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'],
];
// The latin subset's range, as @fontsource publishes it.
const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const STATIC = '__FRONTIER_STATIC__';
const staticDir = join(root, 'dist/static');
// Start clean so a stale hashed file from an earlier build is never vendored.
rmSync(staticDir, { recursive: true, force: true });
mkdirSync(staticDir, { recursive: true });
const manifest = {};
/** Write `bytes` into dist/static as `<name>.<sha256:12>.<ext>` and record it in the manifest. */
function emitStatic(name, ext, bytes) {
  const file = `${name}.${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.${ext}`;
  writeFileSync(join(staticDir, file), bytes);
  manifest[name] = file;
  return file;
}
const FONT_NAMES = ['public-sans-400', 'public-sans-600', 'public-sans-700', 'ibm-plex-mono-400'];
const oflText = readFileSync(join(root, 'LICENSES/OFL-1.1.txt'));
emitStatic('OFL-1.1', 'txt', oflText);
const fontCss =
  `/*!\nFonts: Public Sans and IBM Plex Mono, served next to this card under the license below.\n\n${oflText.toString('utf8').replaceAll('*/', '* /')}*/` +
  FONTS.map(([family, weight, file], i) => {
    const out = emitStatic(FONT_NAMES[i], 'woff2', readFileSync(join(root, 'node_modules', file)));
    return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(${STATIC}/${out}) format('woff2');unicode-range:${LATIN}}`;
  }).join('');


// The file viewers (sheet, PDF, Word) are separate hashed files the card loads on demand; each
// is an IIFE that registers itself on window.__frontierViewers. They are never inlined in the card.
// minify drops the libraries' own header comments, so each viewer file starts with a /*! banner that
// names every bundled component with its license and copyright line, then the license texts once.
const VIEWERS = ['sheet', 'pdf', 'docx'];
const COMPONENTS = {
  sheet: [['SheetJS Community Edition (xlsx)', '0.20.3', 'Apache-2.0', 'Copyright (C) 2012-present SheetJS LLC']],
  pdf: [
    ['PDF.js (pdfjs-dist)', '4.10.38', 'Apache-2.0', 'Copyright 2024 Mozilla Foundation'],
    // pdf.worker.mjs inlines an Emscripten build of OpenJPEG (./external/openjpeg/openjpeg.js).
    ['OpenJPEG (Emscripten build, as inlined by PDF.js)', '', 'OpenJPEG-BSD-2-Clause', 'Copyright (c) 2002-2014, Universite catholique de Louvain (UCL), Belgium; and the other OpenJPEG authors, listed in the license text below'],
    ['Emscripten runtime (in the OpenJPEG build)', '', 'MIT', 'Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.'],
  ],
  docx: [
    ['mammoth', '1.13.0', 'BSD-2-Clause', 'Copyright (c) 2013, Michael Williamson'],
    ['@xmldom/xmldom', '0.8.6', 'MIT', 'Copyright 2019 - present Christopher J. Brody and other contributors; Copyright 2012 - 2017 @jindw <jindw@xidea.org> and other contributors'],
    ['base64-js', '1.5.1', 'MIT', 'Copyright (c) 2014 Jameson Little'],
    ['buffer', '4.9.1', 'MIT', 'Copyright (c) Feross Aboukhadijeh, and other contributors.'],
    ['dingbat-to-unicode', '1.0.2', 'BSD-2-Clause', 'Copyright (c) 2021, Michael Williamson'],
    ['ieee754', '1.1.8', 'BSD-3-Clause', 'Copyright (c) 2008, Fair Oaks Labs, Inc.'],
    ['isarray', '1.0.0', 'MIT', 'Copyright (c) 2013 Julian Gruber <julian@juliangruber.com>'],
    ['jszip', '3.7.1', 'MIT (chosen from MIT OR GPL-3.0-or-later)', 'Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, Antonio Afonso'],
    // Not a header entry of mammoth.browser.js: it sits inside jszip's module.
    ['pako (inside jszip)', '1.0.11', 'MIT AND Zlib', 'Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn; zlib: Copyright (C) 1995-2013 Jean-loup Gailly and Mark Adler', 'nested'],
    ['lop', '0.4.2', 'BSD-2-Clause', 'Copyright (c) 2013, Michael Williamson'],
    ['option', '0.2.4', 'BSD-2-Clause', 'Copyright (c) 2013, Michael Williamson'],
    ['process', '0.11.9', 'MIT', 'Copyright (c) 2013 Roman Shtylman <shtylman@gmail.com>'],
    ['underscore', '1.13.1', 'MIT', 'Copyright (c) 2009-2021 Jeremy Ashkenas, Julian Gonggrijp, and DocumentCloud and Investigative Reporters & Editors'],
    ['xmlbuilder', '10.0.0', 'MIT', 'Copyright (c) 2013 Ozgur Ozcitak'],
  ],
};
// License texts, each written once per file that needs it. The MIT and BSD files hold the
// permission text; the copyright lines are the ones listed above them.
const LICENSE_TEXT = {
  MIT: () => readFileSync(join(root, 'LICENSES/MIT.txt'), 'utf8'),
  'BSD-2-Clause': () => readFileSync(join(root, 'LICENSES/BSD-2-Clause.txt'), 'utf8'),
  'BSD-3-Clause': () => readFileSync(join(root, 'LICENSES/ieee754-BSD-3-Clause.txt'), 'utf8'),
  'OpenJPEG-BSD-2-Clause': () => readFileSync(join(root, 'LICENSES/OpenJPEG-BSD-2-Clause.txt'), 'utf8'),
  Zlib: () => readFileSync(join(root, 'LICENSES/Zlib.txt'), 'utf8'),
  'Apache-2.0': (name) => readFileSync(join(root, 'node_modules', name === 'sheet' ? 'xlsx' : 'pdfjs-dist', 'LICENSE'), 'utf8'),
};
// The Word viewer's component list must match the module header of mammoth's browser build.
{
  const header = readFileSync(join(root, 'node_modules/mammoth/mammoth.browser.js'), 'utf8').split('\n')
    .map((l) => /^\/\/ Module: (.+)@([^@\s]+)$/.exec(l)).filter(Boolean).map((m) => `${m[1]}@${m[2]}`).sort();
  const listed = COMPONENTS.docx.filter((c) => c[4] !== 'nested').map((c) => `${c[0]}@${c[1]}`).sort();
  if (JSON.stringify(header) !== JSON.stringify(listed)) {
    throw new Error(`COMPONENTS.docx is out of date with mammoth.browser.js.\nheader: ${header.join(', ')}\nlisted: ${listed.join(', ')}`);
  }
}
function viewerBanner(name) {
  const parts = COMPONENTS[name];
  const ids = [...new Set(parts.flatMap(([, , lic]) => lic.match(/Apache-2\.0|OpenJPEG-BSD-2-Clause|BSD-2-Clause|BSD-3-Clause|Zlib|MIT/g)))];
  const head = parts.map(([n, v, lic, c]) => `${n}${v ? ` ${v}` : ''}\nLicense: ${lic}\n${c}`).join('\n\n');
  const texts = ids.map((id) => `----- ${id} -----\n${LICENSE_TEXT[id](name).trim()}`).join('\n\n');
  const body = `Third-party components bundled in this file, unmodified:\n\n${head}\n\n${texts}`;
  return `/*!\n${body.replaceAll('*/', '* /')}\n*/`;
}
for (const name of VIEWERS) {
  const r = await build({ ...common, entryPoints: [`app/viewers/${name}.ts`], format: 'iife', target: 'es2022',
    define: { 'process.env.NODE_ENV': '"production"' }, banner: { js: viewerBanner(name) } });
  emitStatic(`viewer-${name}`, 'js', Buffer.from(r.outputFiles[0].contents));
}

const js = await build({
  ...common,
  plugins: [trimZod],
  entryPoints: ['app/src/main.tsx'],
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: {
    'process.env.NODE_ENV': '"production"',
    __VIEWER_FILES__: JSON.stringify(Object.fromEntries(VIEWERS.map((n) => [n, manifest[`viewer-${n}`]]))),
  },
});
const jsText = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const cssText = (fontCss + css.outputFiles[0].text).replace(/<\/style/gi, '<\\/style');
const html = readFileSync(join(root, 'app/index.html'), 'utf8')
  .replace('<!--CSS-->', () => `<style>${cssText}</style>`)
  .replace('<!--JS-->', () => `<script>${jsText}</script>`);

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist/task-card.html');
// Write then rename so a concurrent reader never sees a half-written file.
const tmp = `${out}.${process.pid}.tmp`;
writeFileSync(tmp, html);
renameSync(tmp, out);
writeFileSync(join(staticDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`dist/task-card.html ${Buffer.byteLength(html)} bytes; static files: ${Object.values(manifest).join(', ')}`);
