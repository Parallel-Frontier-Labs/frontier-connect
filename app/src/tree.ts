import type { Deliverable } from './types';

/**
 * The delivered files as a tree, the way Frontier's own app shows them: paths are relative to the
 * task's delivered folder; when every file sits under one shared top folder, that folder becomes the
 * location ("Workspace / <root>/") and the tree starts inside it. Files come before folders, each
 * in the order the run produced them.
 */
export type TreeNode =
  | { kind: 'dir'; name: string; path: string; children: TreeNode[]; fileCount: number }
  | { kind: 'file'; name: string; path: string; key: string };

export interface Delivery {
  root: string | null;
  nodes: TreeNode[];
  fileCount: number;
  nested: boolean;
}

type Dir = Extract<TreeNode, { kind: 'dir' }>;

export function buildDelivery(files: Deliverable[]): Delivery {
  const items = files.map((f, i) => ({ key: `${i}:${f.path}`, segs: f.path.split('/').filter(Boolean), name: f.name }));
  const heads = new Set(items.map((x) => (x.segs.length > 1 ? x.segs[0] : null)));
  const root = items.length > 0 && heads.size === 1 && !heads.has(null) ? (items[0]!.segs[0] ?? null) : null;
  const top: Dir = { kind: 'dir', name: root ?? '', path: root ?? '', children: [], fileCount: 0 };
  for (const { key, segs, name } of items) {
    const inner = root ? segs.slice(1) : segs;
    let dir = top;
    for (const seg of inner.slice(0, -1)) {
      let next = dir.children.find((c): c is Dir => c.kind === 'dir' && c.name === seg);
      if (!next) {
        next = { kind: 'dir', name: seg, path: dir.path ? `${dir.path}/${seg}` : seg, children: [], fileCount: 0 };
        dir.children.push(next);
      }
      dir = next;
    }
    const leaf = inner[inner.length - 1] ?? name;
    dir.children.push({ kind: 'file', name: leaf, path: dir.path ? `${dir.path}/${leaf}` : leaf, key });
  }
  const finish = (d: Dir): void => {
    // A stable sort: files first, then folders, each kept in delivery order.
    d.children.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'file' ? -1 : 1));
    for (const c of d.children) {
      if (c.kind === 'dir') {
        finish(c);
        d.fileCount += c.fileCount;
      } else d.fileCount += 1;
    }
  };
  finish(top);
  return { root, nodes: top.children, fileCount: top.fileCount, nested: top.children.some((c) => c.kind === 'dir') };
}

/** Every folder path, depth first. */
export function allDirs(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) if (n.kind === 'dir') { out.push(n.path); walk(n.children); }
  };
  walk(nodes);
  return out;
}

/** The first file in tree order (what the path line starts on). */
export function firstFile(nodes: TreeNode[]): Extract<TreeNode, { kind: 'file' }> | null {
  for (const n of nodes) {
    if (n.kind === 'file') return n;
    const hit = firstFile(n.children);
    if (hit) return hit;
  }
  return null;
}

export function findFile(nodes: TreeNode[], key: string | null): Extract<TreeNode, { kind: 'file' }> | null {
  if (key === null) return null;
  for (const n of nodes) {
    if (n.kind === 'file') { if (n.key === key) return n; }
    else { const hit = findFile(n.children, key); if (hit) return hit; }
  }
  return null;
}
