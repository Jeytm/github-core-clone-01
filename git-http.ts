// git-http.ts — git smart HTTP: advertisements, protocol v2 ls-refs/fetch,
// protocol v0 fetch, and v0 receive-pack.
//
// The wire rules this implements:
//   - info/refs answers the service preamble plus a v0 ref advertisement, or
//     `version 2` plus capabilities when Git-Protocol: version=2 is asked.
//   - ls-refs filters server-side by ref-prefix, reports the HEAD symref and
//     peeled tags, and names unborn refs when asked.
//   - fetch sends only what the client lacks (haves cut at shallow
//     boundaries), honours deepen/shallow, and frames its pack in sideband.
//   - receive-pack enforces fast-forward per ref, applies the refs it accepts,
//     and reports one ok/ng line per command, inside sideband band 1.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  encodePktLine,
  encodePktLines,
  decodePktLinesPrefix,
  isOid,
  packetLines,
  parseTag,
  planFetch,
  readPack,
  writePack,
  type GitObject,
  type Packet,
} from './git.ts';
import { DEFAULT_BRANCH, type ForgeStore, type RepoRecord } from './store.ts';

const AGENT = 'forge/1.0';

export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function jsonResponse(status: number, message: string): GitResponse {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

function peelToAny(oid: string, repo: RepoRecord, store: ForgeStore): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const object = store.getObject(repo, current);
    if (!object || object.type !== 'tag') return current;
    try {
      current = parseTag(object.data).object;
    } catch {
      return current;
    }
  }
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function uploadPackV0Caps(repo: RepoRecord): string {
  return `side-band-64k shallow thin-pack ofs-delta multi_ack_detailed symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
}

function receivePackCaps(): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

function refAdvertisementLines(repo: RepoRecord, store: ForgeStore, caps: string): string[] {
  const refs = store.listRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    return lines;
  }
  const headTip = store.getRef(repo, `refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  lines.push(`${headTip} HEAD\0${caps}\n`);
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}\n`);
    const object = store.getObject(repo, ref.oid);
    if (object && object.type === 'tag') {
      const peeled = peelToAny(ref.oid, repo, store);
      if (peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  return lines;
}

export function infoRefs(
  store: ForgeStore,
  repo: RepoRecord | undefined,
  service: string,
  wantV2: boolean,
): GitResponse {
  if (!repo) return jsonResponse(404, 'Repository not found');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return jsonResponse(400, 'unknown service');
  }
  const preamble = `# service=${service}\n`;
  if (service === 'git-upload-pack' && wantV2) {
    const body = encodePktLines([
      preamble,
      'flush',
      'version 2\n',
      'ls-refs=unborn\n',
      'fetch=shallow filter\n',
      'object-format=sha1\n',
      `agent=${AGENT}\n`,
      'flush',
    ]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  const caps = service === 'git-upload-pack' ? uploadPackV0Caps(repo) : receivePackCaps();
  const lines = refAdvertisementLines(repo, store, caps);
  const body = Buffer.concat([
    encodePktLine(preamble),
    PKT_FLUSH,
    encodePktLines(lines),
    PKT_FLUSH,
  ]);
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  return { status: 200, contentType, body };
}

// ---------------------------------------------------------------------------
// protocol v2: ls-refs
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(store: ForgeStore, repo: RepoRecord, args: LsRefsArgs): GitResponse {
  const lines: string[] = [];
  const refs = store.listRefs(repo);
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headTip = store.getRef(repo, `refs/heads/${repo.defaultBranch}`);
  if (matches('HEAD')) {
    if (headTip) {
      const symref = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      lines.push(`${headTip} HEAD${symref}\n`);
    } else if (args.unborn) {
      const symref = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      lines.push(`unborn HEAD${symref}\n`);
    }
  }
  for (const ref of refs) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const object = store.getObject(repo, ref.oid);
      if (object && object.type === 'tag') {
        const peeled = peelToAny(ref.oid, repo, store);
        if (peeled !== ref.oid) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  const body = Buffer.concat([encodePktLines(lines), PKT_FLUSH]);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

// ---------------------------------------------------------------------------
// fetch (shared planning for v2 and v0)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  since: number | null;
  deepenNot: string[];
  filter: string | null;
}

function parseFetchLines(lines: string[], args: FetchArgs): void {
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isInteger(depth) && depth > 0) args.depth = depth;
    } else if (line.startsWith('deepen-since ')) {
      const since = Number(line.slice(13).trim());
      if (Number.isFinite(since) && since > 0) args.since = since;
    } else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('filter ')) args.filter = line.slice(7).trim();
    // done, thin-pack, no-progress, ofs-delta and agent lines need no action:
    // this server always sends whole objects, never deltas, and no progress.
  }
}

function buildPackForFetch(store: ForgeStore, repo: RepoRecord, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[]; acks: string[] } {
  const excludeTips: string[] = [];
  for (const ref of args.deepenNot) {
    const oid = store.resolveRef(repo, ref);
    if (oid) excludeTips.push(oid);
  }
  const lookup = store.lookup(repo);
  const plan = planFetch(args.wants, args.haves, args.shallow, args.depth, args.since, excludeTips, lookup);
  let send = plan.send;
  if (args.filter === 'blob:none') {
    send = send.filter((oid) => store.getObject(repo, oid)?.type !== 'blob');
  } else if (args.filter !== null && args.filter.startsWith('blob:limit=')) {
    const limit = Number(args.filter.slice('blob:limit='.length));
    if (Number.isFinite(limit)) {
      send = send.filter((oid) => {
        const object = store.getObject(repo, oid);
        return !object || object.type !== 'blob' || object.data.length <= limit;
      });
    }
  }
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = store.getObject(repo, oid);
    if (object) objects.push(object);
  }
  const acks: string[] = [];
  for (const have of args.haves) {
    if (store.getObject(repo, have)) acks.push(have);
  }
  return { pack: writePack(objects), shallow: plan.shallowOut, unshallow: plan.unshallowOut, acks };
}

/** Frame pack bytes as sideband band-1 packets, each within the pkt-line cap. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (parts.length === 0) parts.push(encodePktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

function handleFetchV2(store: ForgeStore, repo: RepoRecord, args: FetchArgs): GitResponse {
  const { pack, shallow, unshallow, acks } = buildPackForFetch(store, repo, args);
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client negotiated: a
  // client that sent no haves expects the packfile section immediately,
  // and dies on a stray "acknowledgments" header.
  if (args.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    if (acks.length > 0) {
      for (const ack of acks) parts.push(encodePktLine(`ACK ${ack}\n`));
      parts.push(encodePktLine('ready\n'));
    } else {
      parts.push(encodePktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function handleFetchV0(store: ForgeStore, repo: RepoRecord, args: FetchArgs): GitResponse {
  const { pack, shallow, unshallow, acks } = buildPackForFetch(store, repo, args);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (acks.length > 0) {
    for (const ack of acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------
// upload-pack entry points
// ---------------------------------------------------------------------------

export function uploadPack(
  store: ForgeStore,
  repo: RepoRecord | undefined,
  body: Buffer,
  isV2: boolean,
): GitResponse {
  if (!repo) return jsonResponse(404, 'Repository not found');
  const { packets } = decodePktLinesPrefix(body);
  const dataPackets = packets.filter((packet): packet is Extract<Packet, { kind: 'data' }> => packet.kind === 'data');
  if (dataPackets.length === 0) return jsonResponse(400, 'malformed pkt-line stream');

  if (isV2) {
    const lines = packetLines(packets);
    const commandLine = (lines[0] ?? '').replace(/\n$/, '');
    const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length) : '';
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : packets.slice(1);
    const argLines = packetLines(argPackets);
    if (command === 'ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const raw of argLines) {
        const line = raw.replace(/\n$/, '');
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
      }
      return handleLsRefs(store, repo, args);
    }
    if (command === 'fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, since: null, deepenNot: [], filter: null };
      parseFetchLines(argLines, args);
      if (args.wants.length === 0) return jsonResponse(400, 'fetch without a want');
      return handleFetchV2(store, repo, args);
    }
    return jsonResponse(400, `unknown v2 command ${JSON.stringify(command)}`);
  }

  // Protocol v0: want/have lines across two flush-separated sections.
  const lines = packetLines(packets);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, since: null, deepenNot: [], filter: null };
  parseFetchLines(lines, args);
  if (args.wants.length === 0) return jsonResponse(400, 'fetch without a want');
  return handleFetchV0(store, repo, args);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function validRefName(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.length > 200) return false;
  if (/[\s\u0000-\u001f~^:?*[\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.endsWith('.lock') || ref.endsWith('/') || ref.includes('//')) return false;
  return true;
}

export function receivePack(store: ForgeStore, repo: RepoRecord | undefined, body: Buffer): GitResponse {
  if (!repo) return jsonResponse(404, 'Repository not found');
  const { packets, consumed } = decodePktLinesPrefix(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    if (nul >= 0 && commands.length === 0) capabilities = line.slice(nul + 1);
    const parts = head.split(' ');
    if (parts.length !== 3) return jsonResponse(400, 'malformed push command');
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid)) return jsonResponse(400, 'push command has a bad object id');
    commands.push({ oldOid, newOid, ref });
  }
  if (!sawFlush || commands.length === 0) return jsonResponse(400, 'push without commands');
  const wantSideband = capabilities.split(' ').includes('side-band-64k');

  // The pack follows the command list's flush, if there is one at all.
  const packBytes = body.subarray(consumed);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => store.getObject(repo, oid));
      store.putObjects(repo, read.objects);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const verdict = applyPushCommand(store, repo, command);
      reportLines.push(verdict === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict}\n`);
    }
  }

  const inner = Buffer.concat([encodePktLines(reportLines), PKT_FLUSH]);
  let out: Buffer;
  if (wantSideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65500;
    for (let offset = 0; offset < inner.length; offset += CHUNK) {
      const slice = inner.subarray(offset, Math.min(inner.length, offset + CHUNK));
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    parts.push(PKT_FLUSH);
    out = Buffer.concat(parts);
  } else {
    out = inner;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: out };
}

/** Apply one push command; returns null on success, else the ng reason. */
function applyPushCommand(store: ForgeStore, repo: RepoRecord, command: PushCommand): string | null {
  if (!validRefName(command.ref)) return 'invalid ref name';
  const current = store.getRef(repo, command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return 'ref does not exist';
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return 'stale old object id';
    store.deleteRef(repo, command.ref);
    return null;
  }
  const object = store.getObject(repo, command.newOid);
  if (!object) return 'object not found';
  if (command.ref.startsWith('refs/heads/') && object.type !== 'commit') return 'not a commit';
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return 'ref already exists';
    store.setRef(repo, command.ref, command.newOid);
    return null;
  }
  // Update: the old value must match, and the new tip must descend from it.
  if (current === undefined) return 'ref does not exist';
  if (command.oldOid !== current) return 'stale old object id';
  if (!store.isAncestor(repo, command.oldOid, command.newOid)) return 'non-fast-forward';
  store.setRef(repo, command.ref, command.newOid);
  return null;
}

export { DEFAULT_BRANCH };
