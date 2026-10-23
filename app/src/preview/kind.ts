export type Kind = 'sheet' | 'pdf' | 'docx' | 'html' | 'markdown' | 'text' | 'image' | 'none';
export const MAX_PREVIEW_BYTES = 26214400;
/** Live HTML in a sandboxed frame. Set to false if probe test 13 fails on a host (see Global Constraints). */
export const HTML_FRAME = true;
const group = (k: Kind, exts: string) => Object.fromEntries(exts.split(' ').map((e) => [e, k]));
const BY_EXT: Record<string, Kind> = {
  ...group('sheet', 'xlsx xls xlsm xlsb ods fods numbers csv tsv'),
  ...group('pdf', 'pdf'),
  ...group('docx', 'docx'),
  ...group('html', 'html htm'),
  ...group('markdown', 'md markdown'),
  ...group('text', 'txt json log xml yaml yml ofx qfx qbo iif txf ini sql py js ts css'),
  ...group('image', 'png jpg jpeg gif webp bmp avif'),
};
export function kindOf(name: string): Kind {
  const i = name.lastIndexOf('.');
  if (i <= 0) return 'none';
  const ext = name.slice(i + 1).toLowerCase();
  return Object.hasOwn(BY_EXT, ext) ? BY_EXT[ext]! : 'none';
}
