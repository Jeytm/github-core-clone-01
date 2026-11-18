// store.ts — the forge's in-memory store and the rules that shape it.
//
// One store serves git, REST, GraphQL and MCP, so an object created on any
// surface reads back identically on the others. Everything lives in Maps;
// nothing touches the disk. Time comes only from the trial clock (the
// MAKEFUN_TRIAL_NOW second, or a fixed epoch), so two runs on the same
// instance leave byte-identical state.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type CommitInfo,
  type GitObject,
  type TreeEntry,
} from './git.ts';
import type { ForgeIdentity } from './scenario.ts';

export const DEFAULT_BRANCH = 'main';
const FALLBACK_NOW_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario epoch.

// ---------------------------------------------------------------------------
// global ids (opaque, stable, decodable)
// ---------------------------------------------------------------------------

export type GlobalIdKind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment';

export function encodeGlobalId(kind: GlobalIdKind, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: GlobalIdKind; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    const kind = text.slice(0, colon);
    if (kind !== 'Repository' && kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'IssueComment') return null;
    return { kind: kind as GlobalIdKind, key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

export interface LabelRecord {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface CommentRecord {
  readonly id: number;
  readonly body: string;
  readonly authorLogin: string;
  readonly createdSeq: number;
}

export interface IssueRecord {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: LabelRecord[];
  readonly authorLogin: string;
  readonly createdSeq: number;
  updatedSeq: number;
  readonly comments: CommentRecord[];
}

export interface PullRecord {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headShaAtCreation: string;
  readonly baseShaAtCreation: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly authorLogin: string;
  readonly createdSeq: number;
  updatedSeq: number;
}

export interface RepoRecord {
  readonly dbId: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, LabelRecord>;
  readonly issues: Map<number, IssueRecord>;
  readonly pulls: Map<number, PullRecord>;
  nextNumber: number;
  readonly depthCache: Map<string, number>;
}

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export class ForgeStore {
  readonly viewer: ForgeIdentity;
  readonly nowSec: number;
  private readonly repos = new Map<string, RepoRecord>();
  private repoSeq = 0;
  private nextDbId = 1;
  private nextObjectId = 1;
  private nextLabelId = 1;
  private nextCommentId = 1;
  private seq = 0;

  constructor(viewer: ForgeIdentity, nowSec: number | null) {
    this.viewer = viewer;
    this.nowSec = nowSec !== null && Number.isFinite(nowSec) && nowSec > 0 ? Math.trunc(nowSec) : FALLBACK_NOW_SEC;
  }

  /** The one timestamp the forge ever reports, ISO from the trial second. */
  nowIso(): string {
    return new Date(this.nowSec * 1000).toISOString();
  }

  private tick(): number {
    this.seq += 1;
    return this.seq;
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  // ------------------------------------------------------------- repositories

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRecord | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    this.repoSeq += 1;
    const repo: RepoRecord = {
      dbId: this.nextDbId,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.repoSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      depthCache: new Map(),
    };
    this.nextDbId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): RepoRecord[] {
    const out: RepoRecord[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  repoGlobalId(repo: RepoRecord): string {
    return encodeGlobalId('Repository', String(repo.dbId));
  }

  findRepoByGlobalId(id: string): RepoRecord | null {
    const decoded = decodeGlobalId(id);
    if (!decoded || decoded.kind !== 'Repository') return null;
    const dbId = Number(decoded.key);
    if (!Number.isInteger(dbId)) return null;
    for (const repo of this.repos.values()) {
      if (repo.dbId === dbId) return repo;
    }
    return null;
  }

  // ------------------------------------------------------------- git objects

  putObject(repo: RepoRecord, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(repo: RepoRecord, objects: ReadonlyMap<string, GitObject>): void {
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }

  getObject(repo: RepoRecord, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  lookup(repo: RepoRecord): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  commitInfo(repo: RepoRecord, oid: string): CommitInfo | null {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    try {
      return parseCommit(object.data);
    } catch {
      return null;
    }
  }

  /** Generations: a root is 0, a child is one past its deepest parent. */
  depthOf(repo: RepoRecord, oid: string): number {
    const cached = repo.depthCache.get(oid);
    if (cached !== undefined) return cached;
    const seen = new Set<string>();
    const walk = (current: string): number => {
      const hit = repo.depthCache.get(current);
      if (hit !== undefined) return hit;
      if (seen.has(current)) return 0;
      seen.add(current);
      const info = this.commitInfo(repo, current);
      if (!info) return 0;
      let depth = 0;
      for (const parent of info.parents) depth = Math.max(depth, walk(parent) + 1);
      repo.depthCache.set(current, depth);
      return depth;
    };
    return walk(oid);
  }

  isAncestor(repo: RepoRecord, maybeAncestor: string, oid: string): boolean {
    if (maybeAncestor === oid) return true;
    const ancestorDepth = this.depthOf(repo, maybeAncestor);
    const seen = new Set<string>();
    const queue: string[] = [oid];
    while (queue.length) {
      const current = queue.pop() as string;
      if (current === maybeAncestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      if (this.depthOf(repo, current) <= ancestorDepth) continue;
      const info = this.commitInfo(repo, current);
      if (!info) continue;
      for (const parent of info.parents) queue.push(parent);
    }
    return false;
  }

  mergeBase(repo: RepoRecord, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length) {
      const current = queueA.pop() as string;
      if (ancestorsA.has(current)) continue;
      ancestorsA.add(current);
      const info = this.commitInfo(repo, current);
      if (info) for (const parent of info.parents) queueA.push(parent);
    }
    let best: string | null = null;
    let bestDepth = -1;
    const seenB = new Set<string>();
    const queueB: string[] = [b];
    while (queueB.length) {
      const current = queueB.pop() as string;
      if (seenB.has(current)) continue;
      seenB.add(current);
      if (ancestorsA.has(current)) {
        const depth = this.depthOf(repo, current);
        if (depth > bestDepth) {
          bestDepth = depth;
          best = current;
        }
      }
      const info = this.commitInfo(repo, current);
      if (info) for (const parent of info.parents) queueB.push(parent);
    }
    return best;
  }

  // ------------------------------------------------------------- refs

  getRef(repo: RepoRecord, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: RepoRecord, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: RepoRecord, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  listRefs(repo: RepoRecord): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    for (const [name, oid] of repo.refs) out.push({ name, oid });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /**
   * Resolve a branch name, full ref, HEAD, or raw oid to a commit oid.
   * Tags peel to their commit. Returns null when nothing matches.
   */
  resolveRef(repo: RepoRecord, refish: string): string | null {
    if (refish === 'HEAD') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ?? null;
    }
    if (isOid(refish)) {
      const object = repo.objects.get(refish);
      if (!object) return null;
      if (object.type === 'commit') return refish;
      return peelToCommit(refish, this.lookup(repo));
    }
    const candidates = refish.startsWith('refs/')
      ? [refish]
      : [`refs/heads/${refish}`, `refs/tags/${refish}`];
    for (const candidate of candidates) {
      const oid = repo.refs.get(candidate);
      if (oid === undefined) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') return oid;
      const peeled = peelToCommit(oid, this.lookup(repo));
      if (peeled) return peeled;
      return oid;
    }
    return null;
  }

  /** Resolve to the exact ref name a branch-ish names, for ref reads. */
  resolveRefName(repo: RepoRecord, refish: string): string | null {
    if (refish.startsWith('refs/')) return repo.refs.has(refish) ? refish : null;
    if (repo.refs.has(`refs/heads/${refish}`)) return `refs/heads/${refish}`;
    if (repo.refs.has(`refs/tags/${refish}`)) return `refs/tags/${refish}`;
    return null;
  }

  // ------------------------------------------------------------- trees

  flattenTree(repo: RepoRecord, treeOid: string): Map<string, { oid: string; mode: string }> {
    const flat = new Map<string, { oid: string; mode: string }>();
    const walk = (current: string, prefix: string): void => {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return;
      let entries: TreeEntry[];
      try {
        entries = parseTree(object.data);
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') flat.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return flat;
  }

  /** Build (and store) the tree objects for a flat path map; returns the root oid. */
  buildTreeFromMap(repo: RepoRecord, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i] as string;
        let child = node.dirs.get(segment);
        if (!child) {
          child = make();
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1] as string, value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  createCommit(repo: RepoRecord, tree: string, parents: readonly string[], message: string): string {
    const identity = `${this.viewer.name} <${this.viewer.email}>`;
    const data = buildCommit({
      tree,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: identity,
      committer: identity,
      timestamp: this.nowSec,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** Commits reachable from `tip`, newest first (depth-first pre-order). */
  listCommits(repo: RepoRecord, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const info = this.commitInfo(repo, oid);
      if (!info) continue;
      out.push(oid);
      for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i] as string);
    }
    return out;
  }

  // ------------------------------------------------------------- diff & merge

  private blobLines(repo: RepoRecord, oid: string | null): string[] {
    if (oid === null) return [];
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'blob') return [];
    const text = object.data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** Line additions/deletions between two blob versions, via LCS. */
  private lineDiff(repo: RepoRecord, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
    const oldLines = this.blobLines(repo, oldOid);
    const newLines = this.blobLines(repo, newOid);
    if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
    if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
    if (oldLines.length * newLines.length > 250_000) {
      // Very large files: count whole-file churn rather than diffing.
      return { additions: newLines.length, deletions: oldLines.length };
    }
    const m = oldLines.length;
    const n = newLines.length;
    let prev = new Array<number>(n + 1).fill(0);
    for (let i = 1; i <= m; i += 1) {
      const cur = new Array<number>(n + 1).fill(0);
      for (let j = 1; j <= n; j += 1) {
        cur[j] = oldLines[i - 1] === newLines[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, cur[j - 1] as number);
      }
      prev = cur;
    }
    const lcs = prev[n] as number;
    return { additions: n - lcs, deletions: m - lcs };
  }

  /** The file-level diff between two trees (null base = empty tree). */
  diffTrees(repo: RepoRecord, baseTree: string | null, headTree: string): FileChange[] {
    const base = baseTree === null ? new Map() : this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const changes: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const oldEntry = base.get(path);
      const newEntry = head.get(path);
      if (oldEntry && !newEntry) {
        const counts = this.lineDiff(repo, oldEntry.oid, null);
        changes.push({ path, status: 'removed', additions: 0, deletions: counts.deletions, oldOid: oldEntry.oid, newOid: null });
      } else if (!oldEntry && newEntry) {
        const counts = this.lineDiff(repo, null, newEntry.oid);
        changes.push({ path, status: 'added', additions: counts.additions, deletions: 0, oldOid: null, newOid: newEntry.oid });
      } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
        const counts = this.lineDiff(repo, oldEntry.oid, newEntry.oid);
        changes.push({ path, status: 'modified', additions: counts.additions, deletions: counts.deletions, oldOid: oldEntry.oid, newOid: newEntry.oid });
      }
    }
    return changes;
  }

  /**
   * Three-way merge of `headTip` into `baseTip` over their merge-base. Returns
   * the merged flat tree, or null when the same path changed both ways.
   */
  threeWayMerge(repo: RepoRecord, baseTip: string, headTip: string): Map<string, { oid: string; mode: string }> | null {
    const baseInfo = this.commitInfo(repo, baseTip);
    const headInfo = this.commitInfo(repo, headTip);
    if (!baseInfo || !headInfo) return null;
    const mergeBaseOid = this.mergeBase(repo, baseTip, headTip);
    const baseTree = mergeBaseOid === null ? null : this.commitInfo(repo, mergeBaseOid)?.tree ?? null;
    const ancestor = baseTree === null ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(repo, baseTree);
    const ours = this.flattenTree(repo, baseInfo.tree);
    const theirs = this.flattenTree(repo, headInfo.tree);
    const paths = new Set<string>([...ancestor.keys(), ...ours.keys(), ...theirs.keys()]);
    const merged = new Map<string, { oid: string; mode: string }>();
    for (const path of paths) {
      const a = ancestor.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const same = (x: { oid: string } | undefined, y: { oid: string } | undefined): boolean =>
        (x?.oid ?? null) === (y?.oid ?? null);
      if (same(o, t)) {
        if (o) merged.set(path, o);
      } else if (same(a, o)) {
        if (t) merged.set(path, t);
      } else if (same(a, t)) {
        if (o) merged.set(path, o);
      } else {
        return null; // Both sides changed this path differently: a conflict.
      }
    }
    return merged;
  }

  // ------------------------------------------------------------- contents

  normalizePath(path: string): string | null {
    const segments: string[] = [];
    for (const segment of path.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') return null;
      segments.push(segment);
    }
    return segments.join('/');
  }

  readPath(
    repo: RepoRecord,
    tip: string,
    path: string,
  ): { kind: 'file'; oid: string; size: number } | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; mode: string }> } | null {
    const info = this.commitInfo(repo, tip);
    if (!info) return null;
    const flat = this.flattenTree(repo, info.tree);
    const file = flat.get(path);
    if (file) {
      const blob = repo.objects.get(file.oid);
      return { kind: 'file', oid: file.oid, size: blob?.data.length ?? 0 };
    }
    // A directory: everything below `path/`, grouped one level down.
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { oid: string; mode: string; isDir: boolean }>();
    for (const [full, entry] of flat) {
      if (prefix !== '' && !full.startsWith(prefix)) continue;
      const rest = prefix === '' ? full : full.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        children.set(rest, { oid: entry.oid, mode: entry.mode, isDir: false });
      } else {
        const dirName = rest.slice(0, slash);
        if (!children.has(dirName)) {
          // The subtree's oid: resolve by walking the tree objects.
          const dirOid = this.subtreeOid(repo, info.tree, prefix + dirName);
          children.set(dirName, { oid: dirOid ?? ZERO_OID, mode: '40000', isDir: true });
        }
      }
    }
    if (children.size === 0) return null;
    const entries = [...children.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, value]) => ({ name, path: prefix + name, oid: value.oid, mode: value.mode }));
    return { kind: 'dir', entries };
  }

  private subtreeOid(repo: RepoRecord, treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (const segment of segments) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      let entries: TreeEntry[];
      try {
        entries = parseTree(object.data);
      } catch {
        return null;
      }
      const entry = entries.find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (!entry) return null;
      current = entry.oid;
    }
    return current;
  }

  // ------------------------------------------------------------- labels

  createLabel(repo: RepoRecord, name: string, color: string, description: string): LabelRecord | null {
    if (repo.labels.has(name)) return null;
    const label: LabelRecord = { id: this.nextLabelId, name, color, description };
    this.nextLabelId += 1;
    repo.labels.set(name, label);
    return label;
  }

  // ------------------------------------------------------------- issues & PRs

  createIssue(repo: RepoRecord, title: string, body: string | null, labelNames: string[]): { issue: IssueRecord } | { unknownLabel: string } {
    const labels: LabelRecord[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { unknownLabel: name };
      labels.push(label);
    }
    const seq = this.tick();
    const issue: IssueRecord = {
      id: this.nextObjectId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels,
      authorLogin: this.viewer.login,
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
    };
    this.nextObjectId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return { issue };
  }

  createPull(
    repo: RepoRecord,
    title: string,
    body: string | null,
    headRef: string,
    baseRef: string,
    headSha: string,
    baseSha: string,
  ): PullRecord {
    const seq = this.tick();
    const pull: PullRecord = {
      id: this.nextObjectId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      headRef,
      baseRef,
      headShaAtCreation: headSha,
      baseShaAtCreation: baseSha,
      mergedAt: null,
      mergeCommitSha: null,
      authorLogin: this.viewer.login,
      createdSeq: seq,
      updatedSeq: seq,
    };
    this.nextObjectId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  issueGlobalId(repo: RepoRecord, issue: IssueRecord): string {
    return encodeGlobalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
  }

  pullGlobalId(repo: RepoRecord, pull: PullRecord): string {
    return encodeGlobalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
  }

  commentGlobalId(repo: RepoRecord, comment: CommentRecord): string {
    return encodeGlobalId('IssueComment', `${repo.owner}/${repo.name}#c${comment.id}`);
  }

  findIssueByGlobalId(id: string): { repo: RepoRecord; issue: IssueRecord } | null {
    const decoded = decodeGlobalId(id);
    if (!decoded || decoded.kind !== 'Issue') return null;
    const hash = decoded.key.lastIndexOf('#');
    if (hash < 0) return null;
    const fullName = decoded.key.slice(0, hash);
    const number = Number(decoded.key.slice(hash + 1));
    const slash = fullName.indexOf('/');
    if (slash < 0 || !Number.isInteger(number)) return null;
    const repo = this.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
    if (!repo) return null;
    const issue = repo.issues.get(number);
    return issue ? { repo, issue } : null;
  }

  findPullByGlobalId(id: string): { repo: RepoRecord; pull: PullRecord } | null {
    const decoded = decodeGlobalId(id);
    if (!decoded || decoded.kind !== 'PullRequest') return null;
    const hash = decoded.key.lastIndexOf('#');
    if (hash < 0) return null;
    const fullName = decoded.key.slice(0, hash);
    const number = Number(decoded.key.slice(hash + 1));
    const slash = fullName.indexOf('/');
    if (slash < 0 || !Number.isInteger(number)) return null;
    const repo = this.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
    if (!repo) return null;
    const pull = repo.pulls.get(number);
    return pull ? { repo, pull } : null;
  }

  addComment(repo: RepoRecord, issue: IssueRecord, body: string): CommentRecord {
    const comment: CommentRecord = {
      id: this.nextCommentId,
      body,
      authorLogin: this.viewer.login,
      createdSeq: this.tick(),
    };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    issue.updatedSeq = this.tick();
    return comment;
  }

  /** Current tip shas for a PR's branches, falling back to creation shas. */
  pullTips(repo: RepoRecord, pull: PullRecord): { headSha: string; baseSha: string } {
    const head = this.resolveRef(repo, pull.headRef) ?? pull.headShaAtCreation;
    const base = this.resolveRef(repo, pull.baseRef) ?? pull.baseShaAtCreation;
    return { headSha: head, baseSha: base };
  }

  pullFiles(repo: RepoRecord, pull: PullRecord): FileChange[] {
    const { headSha, baseSha } = this.pullTips(repo, pull);
    const headInfo = this.commitInfo(repo, headSha);
    if (!headInfo) return [];
    const baseOid = this.mergeBase(repo, baseSha, headSha);
    const baseTree = baseOid === null ? null : (this.commitInfo(repo, baseOid)?.tree ?? null);
    return this.diffTrees(repo, baseTree, headInfo.tree);
  }

  pullMergeable(repo: RepoRecord, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const { headSha, baseSha } = this.pullTips(repo, pull);
    if (!this.commitInfo(repo, headSha) || !this.commitInfo(repo, baseSha)) return 'UNKNOWN';
    return this.threeWayMerge(repo, baseSha, headSha) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge an open PR onto its base branch: one commit carrying the
   * merged tree, parented on the base tip. Returns the merge commit sha, or
   * null when the merge conflicts.
   */
  mergePull(repo: RepoRecord, pull: PullRecord): string | null {
    const { headSha, baseSha } = this.pullTips(repo, pull);
    const merged = this.threeWayMerge(repo, baseSha, headSha);
    if (merged === null) return null;
    const tree = this.buildTreeFromMap(repo, merged);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const sha = this.createCommit(repo, tree, [baseSha], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedSeq = this.tick();
    return sha;
  }

  openCount(repo: RepoRecord): number {
    let count = 0;
    for (const issue of repo.issues.values()) if (issue.state === 'open') count += 1;
    for (const pull of repo.pulls.values()) if (pull.state === 'open') count += 1;
    return count;
  }

  reachableCount(repo: RepoRecord, tip: string): number {
    return collectReachable([tip], this.lookup(repo)).size;
  }
}
