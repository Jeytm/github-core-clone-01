// git.ts — the git object model, pkt-line framing and packfiles.
//
// Everything here is byte-level git, implemented from the protocol's own
// rules: SHA-1 object ids over `<type> <size>\0` + bytes, pkt-line framing,
// packfile v2 read (with OFS_DELTA/REF_DELTA) and write (plain objects, no
// deltas — a client must accept undeltified packs, and ours always are).
// No git binary, no dependencies: node:crypto and node:zlib only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitInfo {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  /** Committer timestamp, unix seconds; 0 when unparseable. */
  readonly time: number;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** SHA-1 over the loose-object header plus the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order, directories compared as if suffixed with '/'. */
function treeCompare(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(treeCompare);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  let time = 0;
  const stamp = committer.match(/ (\d+) [+-]\d{4}$/);
  if (stamp) time = Number(stamp[1]);
  return { tree, parents, author, committer, message, time };
}

export interface TagInfo {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const headers = new Map<string, string>();
  for (const line of headerText.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error('tag has an invalid type header');
  }
  return { object, type: type as GitObjectType, tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '', message };
}

export interface BuildCommitOptions {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly committer: string;
  readonly timestamp: number;
  readonly timezone?: string;
}

/** A commit object's bytes, in git's canonical header order. */
export function buildCommit(options: BuildCommitOptions): Buffer {
  const timezone = options.timezone ?? '+0000';
  const lines = [`tree ${options.tree}`];
  for (const parent of options.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${options.author} ${options.timestamp} ${timezone}`);
  lines.push(`committer ${options.committer} ${options.timestamp} ${timezone}`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${options.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export type Packet =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error('pkt-line payload exceeds the maximum');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function encodePktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode pkt-lines from the head of `buffer`. Returns the packets and the
 * offset of the first byte past them, so a caller can keep trailing raw bytes
 * (a packfile) untouched. Throws on a malformed header.
 */
export function decodePktLinesPrefix(buffer: Buffer): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** Decode a whole buffer as pkt-lines; throws on trailing garbage. */
export function decodePktLinesStrict(buffer: Buffer): Packet[] {
  const { packets, consumed } = decodePktLinesPrefix(buffer);
  if (consumed !== buffer.length) throw new Error('trailing bytes after pkt-line stream');
  return packets;
}

export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

function readPackEntryHeader(buffer: Buffer, start: number): { size: number; typeCode: number; next: number } {
  if (start >= buffer.length) throw new Error('pack entry is truncated');
  let byte = buffer[start] as number;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, typeCode, next: offset };
}

function readOfsBase(buffer: Buffer, start: number): { distance: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta base offset is truncated');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { distance: value, next: offset };
}

/** Inflate one zlib stream starting at `offset`; reports where it ends. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of range');
      if (written + copySize > targetSize) throw new Error('delta writes past its target');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly count: number;
}

/**
 * Read a packfile v2/v3, resolving OFS_DELTA and REF_DELTA chains. Thin packs
 * may name bases the caller already holds via `resolveBase`. Every object's
 * id is recomputed from its bytes; the trailer checksum is verified.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack lacks its magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObject;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackEntryHeader(pack, offset);
    offset = header.next;
    const entry: RawEntry = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.distance <= 0 || base.distance > entryOffset) throw new Error('ofs-delta names an invalid base');
      entry.baseOffset = entryOffset - base.distance;
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[header.typeCode]) {
      throw new Error(`pack entry has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch after inflate');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let object: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      const data = applyDelta(base.data, entry.data);
      object = { type: base.type, data };
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      let base: GitObject | undefined;
      for (const candidate of raw) {
        if (candidate.resolved && hashObject(candidate.resolved.type, candidate.resolved.data) === wanted) {
          base = candidate.resolved;
          break;
        }
      }
      if (!base) base = resolveBase?.(wanted);
      if (!base) throw new Error(`ref-delta base ${wanted} is unavailable`);
      const data = applyDelta(base.data, entry.data);
      object = { type: base.type, data };
    } else {
      object = { type: CODE_TYPE[entry.typeCode] as GitObjectType, data: entry.data };
    }
    entry.resolved = object;
    resolving.delete(entry.offset);
    return object;
  };

  for (const entry of raw) {
    const object = resolve(entry);
    const oid = hashObject(object.type, object.data);
    if (!objects.has(oid)) objects.set(oid, object);
  }
  return { objects, count: declaredCount };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects (no deltas), in the given order. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// reachability and fetch planning
// ---------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Peel a tag (recursively) to the commit it ultimately names. */
export function peelToCommit(oid: string, lookup: ObjectLookup): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = lookup(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
}

interface WalkItem {
  oid: string;
  distance: number;
}

/**
 * Plan a fetch: which objects to send, which commits form the new shallow
 * boundary, and which old boundaries are now deepened past.
 *
 * `wants` are the tips the client asked for; `haves` are commits it already
 * holds; `shallow` are its current shallow boundaries (their parents are NOT
 * held, so the exclusion walk stops there); `depth` caps the generations
 * taken from each want; `since` cuts commits older than a timestamp.
 */
export function planFetch(
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[],
  depth: number | null,
  since: number | null,
  excludeTips: readonly string[],
  lookup: ObjectLookup,
): { send: string[]; shallowOut: string[]; unshallowOut: string[] } {
  const shallowSet = new Set(shallow);
  const commitCache = new Map<string, CommitInfo | null>();
  const commitOf = (oid: string): CommitInfo | null => {
    if (commitCache.has(oid)) return commitCache.get(oid) as CommitInfo | null;
    const object = lookup(oid);
    let info: CommitInfo | null = null;
    if (object && object.type === 'commit') {
      try {
        info = parseCommit(object.data);
      } catch {
        info = null;
      }
    }
    commitCache.set(oid, info);
    return info;
  };
  const treeEntries = (oid: string): TreeEntry[] => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return [];
    try {
      return parseTree(object.data);
    } catch {
      return [];
    }
  };

  // The exclusion closure: everything reachable from haves (and deepen-not
  // tips), stopping at shallow boundaries — their parents stay excludable.
  const excluded = new Set<string>();
  {
    const queue: string[] = [...haves, ...excludeTips];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (excluded.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      excluded.add(oid);
      if (object.type === 'commit') {
        if (shallowSet.has(oid) && !excludeTips.includes(oid)) {
          // A shallow boundary: the client holds this commit and its tree,
          // but not its parents. Keep the tree, drop the parents.
          queue.push(commitOf(oid)?.tree ?? '');
          continue;
        }
        const info = commitOf(oid);
        if (info) {
          queue.push(info.tree);
          for (const parent of info.parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        try {
          queue.push(parseTag(object.data).object);
        } catch {
          // A malformed tag contributes nothing further.
        }
      } else if (object.type === 'tree') {
        for (const entry of treeEntries(oid)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    excluded.delete('');
  }

  // The want closure, bounded by depth / timestamp, tracking boundaries.
  const wanted = new Set<string>();
  const boundaries = new Set<string>();
  const distances = new Map<string, number>();
  const queue: WalkItem[] = [];
  for (const want of wants) queue.push({ oid: want, distance: 0 });
  const seenCommit = new Set<string>();
  while (queue.length) {
    const item = queue.shift() as WalkItem;
    const object = lookup(item.oid);
    if (!object) continue;
    if (object.type === 'commit') {
      if (seenCommit.has(item.oid)) {
        const known = distances.get(item.oid) as number;
        if (item.distance >= known) continue;
      }
      seenCommit.add(item.oid);
      distances.set(item.oid, item.distance);
      wanted.add(item.oid);
      const info = commitOf(item.oid);
      if (!info) continue;
      // The tree closure of every included commit travels with it.
      const treeQueue: string[] = [info.tree];
      while (treeQueue.length) {
        const treeOid = treeQueue.pop() as string;
        if (wanted.has(treeOid)) continue;
        const treeObject = lookup(treeOid);
        if (!treeObject) continue;
        wanted.add(treeOid);
        for (const entry of treeEntries(treeOid)) {
          if (entry.mode === '160000') continue;
          if (entry.mode === '40000') treeQueue.push(entry.oid);
          else wanted.add(entry.oid);
        }
      }
      const atDepthLimit = depth !== null && item.distance >= depth - 1;
      const atTimeLimit = since !== null && info.time !== 0 && info.time < since;
      if (atDepthLimit || atTimeLimit) {
        if (info.parents.length > 0) boundaries.add(item.oid);
        continue;
      }
      for (const parent of info.parents) queue.push({ oid: parent, distance: item.distance + 1 });
    } else if (object.type === 'tag') {
      if (wanted.has(item.oid)) continue;
      wanted.add(item.oid);
      try {
        queue.push({ oid: parseTag(object.data).object, distance: item.distance });
      } catch {
        // A malformed tag contributes nothing further.
      }
    } else {
      // A directly-wanted tree or blob travels alone.
      wanted.add(item.oid);
      if (object.type === 'tree') {
        for (const entry of treeEntries(item.oid)) {
          if (entry.mode !== '160000') queue.push({ oid: entry.oid, distance: item.distance });
        }
      }
    }
  }

  const send: string[] = [];
  for (const oid of wanted) {
    if (!excluded.has(oid) && lookup(oid)) send.push(oid);
  }
  send.sort();
  const shallowOut = [...boundaries].filter((oid) => !excluded.has(oid)).sort();
  const unshallowOut: string[] = [];
  for (const oid of shallowSet) {
    // An old boundary is unshallowed when the fetch now reaches past it:
    // it sits inside the want closure strictly above the new boundary.
    if (!distances.has(oid)) continue;
    const distance = distances.get(oid) as number;
    const limit = depth === null ? Number.POSITIVE_INFINITY : depth - 1;
    if (distance < limit && !boundaries.has(oid)) unshallowOut.push(oid);
  }
  unshallowOut.sort();
  return { send, shallowOut, unshallowOut };
}

/** Every object reachable from `roots` (commits, tags, trees, blobs). */
export function collectReachable(roots: readonly string[], lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid) || !isOid(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      queue.push(info.tree);
      for (const parent of info.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}
