// smoke.test.ts — end-to-end checks against the real server: REST, GraphQL,
// MCP, and a git clone/push/pull round trip with the system git client.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createForgeServer } from '../app.ts';
import { deriveViewer } from '../scenario.ts';
import { ForgeStore } from '../store.ts';
import type { Server } from 'node:http';

const TOKEN = 'smoke-test-token';
let server: Server;
let base = '';

before(async () => {
  const store = new ForgeStore(deriveViewer(), 1735689600);
  server = createForgeServer({ store, expectedToken: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown), headers: response.headers };
}

function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'http.proxy=', '-c', `http.extraHeader=Authorization: Bearer ${TOKEN}`, '-c', 'credential.helper=', ...args],
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }, timeout: 20000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

test('healthz and unknown routes answer JSON with a request id', async () => {
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('x-github-request-id') ?? '', /.+/);
  assert.deepEqual(await health.json(), { ok: true });

  const missing = await api('/api/v3/nope');
  assert.equal(missing.status, 404);
  assert.equal(typeof (missing.body as { message: string }).message, 'string');
  assert.match(missing.headers.get('x-github-request-id') ?? '', /.+/);

  const unauthenticated = await fetch(`${base}/api/v3/user`);
  assert.equal(unauthenticated.status, 401);
});

test('REST: repo, contents, issues, branches, pull request, merge', async () => {
  const created = await api('/api/v3/user/repos', { method: 'POST', body: JSON.stringify({ name: 'smoke', private: false }) });
  assert.equal(created.status, 201);
  const repo = created.body as { name: string; default_branch: string };
  assert.equal(repo.name, 'smoke');
  assert.equal(repo.default_branch, 'main');

  const duplicate = await api('/api/v3/user/repos', { method: 'POST', body: JSON.stringify({ name: 'smoke' }) });
  assert.equal(duplicate.status, 422);

  const put = await api('/api/v3/repos/adaiversen/smoke/contents/README.md', {
    method: 'PUT',
    body: JSON.stringify({ message: 'add readme', content: Buffer.from('hello forge\n', 'utf8').toString('base64') }),
  });
  assert.equal(put.status, 201);
  const putBody = put.body as { content: { sha: string }; commit: { sha: string } };
  assert.match(putBody.content.sha, /^[0-9a-f]{40}$/);

  const read = await api('/api/v3/repos/adaiversen/smoke/contents/README.md');
  assert.equal(read.status, 200);
  const file = read.body as { encoding: string; content: string; sha: string };
  assert.equal(file.encoding, 'base64');
  assert.equal(Buffer.from(file.content, 'base64').toString('utf8'), 'hello forge\n');
  assert.equal(file.sha, putBody.content.sha);

  const stale = await api('/api/v3/repos/adaiversen/smoke/contents/README.md', {
    method: 'PUT',
    body: JSON.stringify({ message: 'stale', content: Buffer.from('x', 'utf8').toString('base64'), sha: '0'.repeat(40) }),
  });
  assert.equal(stale.status, 409);

  const issue = await api('/api/v3/repos/adaiversen/smoke/issues', {
    method: 'POST',
    body: JSON.stringify({ title: 'first bug', body: 'it broke' }),
  });
  assert.equal(issue.status, 201);
  assert.equal((issue.body as { number: number }).number, 1);

  const comment = await api('/api/v3/repos/adaiversen/smoke/issues/1/comments', {
    method: 'POST',
    body: JSON.stringify({ body: 'looking into it' }),
  });
  assert.equal(comment.status, 201);

  const branch = await api('/api/v3/repos/adaiversen/smoke/git/refs', {
    method: 'POST',
    body: JSON.stringify({ ref: 'refs/heads/feature', sha: putBody.commit.sha }),
  });
  assert.equal(branch.status, 201);

  const featurePut = await api('/api/v3/repos/adaiversen/smoke/contents/feature.txt?branch=feature', {
    method: 'PUT',
    body: JSON.stringify({ message: 'add feature', content: Buffer.from('feature\n', 'utf8').toString('base64') }),
  });
  assert.equal(featurePut.status, 201);

  const pull = await api('/api/v3/repos/adaiversen/smoke/pulls', {
    method: 'POST',
    body: JSON.stringify({ title: 'add feature', head: 'feature', base: 'main' }),
  });
  assert.equal(pull.status, 201);
  assert.equal((pull.body as { number: number }).number, 2);

  const files = await api('/api/v3/repos/adaiversen/smoke/pulls/2/files');
  assert.equal(files.status, 200);
  const fileList = files.body as Array<{ filename: string; status: string }>;
  assert.equal(fileList.length, 1);
  assert.equal(fileList[0]?.filename, 'feature.txt');
  assert.equal(fileList[0]?.status, 'added');

  const merge = await api('/api/v3/repos/adaiversen/smoke/pulls/2/merge', {
    method: 'PUT',
    body: JSON.stringify({ merge_method: 'squash' }),
  });
  assert.equal(merge.status, 200);
  assert.equal((merge.body as { merged: boolean }).merged, true);

  const mergedRead = await api('/api/v3/repos/adaiversen/smoke/contents/feature.txt?ref=main');
  assert.equal(mergedRead.status, 200);
});

test('GraphQL: viewer, repository, mutation, invalid field', async () => {
  const viewer = await api('/api/graphql', {
    method: 'POST',
    body: JSON.stringify({ query: 'query { viewer { login } }' }),
  });
  assert.equal(viewer.status, 200);
  assert.equal(((viewer.body as { data: { viewer: { login: string } } }).data.viewer.login), 'adaiversen');

  const repo = await api('/api/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query: 'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { name nameWithOwner databaseId viewerPermission hasIssuesEnabled defaultBranchRef { name } } }',
      variables: { owner: 'adaiversen', name: 'smoke' },
    }),
  });
  assert.equal(repo.status, 200);
  const repoData = (repo.body as { data: { repository: { nameWithOwner: string; viewerPermission: string; hasIssuesEnabled: boolean } } }).data.repository;
  assert.equal(repoData.nameWithOwner, 'adaiversen/smoke');
  assert.equal(repoData.viewerPermission, 'ADMIN');
  assert.equal(repoData.hasIssuesEnabled, true);

  const bad = await api('/api/graphql', {
    method: 'POST',
    body: JSON.stringify({ query: 'query { viewer { noSuchFieldOnViewer } }' }),
  });
  assert.equal(bad.status, 200);
  const errors = (bad.body as { errors: Array<{ message: string }> }).errors;
  assert.ok(errors.length >= 1);
  assert.match(errors[0]?.message ?? '', /noSuchFieldOnViewer/);

  const batch = await api('/api/graphql', {
    method: 'POST',
    body: JSON.stringify([
      { query: 'query { viewer { login } }' },
      { query: 'query { repository(owner: "adaiversen", name: "missing") { name } }' },
    ]),
  });
  assert.equal(batch.status, 200);
  const batchBody = batch.body as Array<{ data: unknown }>;
  assert.equal(batchBody.length, 2);
  assert.equal((batchBody[1]?.data as { repository: null }).repository, null);
});

test('MCP: discover, tools/list, tools/call, unknown tool', async () => {
  const discover = await api('/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'server/discover', params: {} }),
  });
  assert.equal(discover.status, 200);
  const discoverResult = (discover.body as { result: { supportedVersions: string[] } }).result;
  assert.ok(discoverResult.supportedVersions.includes('2026-07-28'));

  const list = await api('/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: '2', method: 'tools/list', params: {} }),
  });
  assert.equal(list.status, 200);
  const tools = (list.body as { result: { tools: Array<{ name: string }> } }).result.tools;
  assert.ok(tools.some((tool) => tool.name === 'create_issue'));
  assert.ok(tools.length >= 6);

  const call = await api('/mcp', {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '3',
      method: 'tools/call',
      params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'smoke', title: 'mcp issue' } },
    }),
  });
  assert.equal(call.status, 200);
  const callResult = (call.body as { result: { structuredContent: { title: string } } }).result;
  assert.equal(callResult.structuredContent.title, 'mcp issue');

  const unknown = await api('/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: '4', method: 'tools/call', params: { name: 'nope', arguments: {} } }),
  });
  assert.equal(unknown.status, 200);
  assert.equal((unknown.body as { error: { code: number } }).error.code, -32602);
});

test('git CLI: clone empty, push, clone again, pull', async () => {
  await api('/api/v3/user/repos', { method: 'POST', body: JSON.stringify({ name: 'cli-repo' }) });
  const home = await mkdtemp(join(tmpdir(), 'forge-home-'));
  const work = await mkdtemp(join(tmpdir(), 'forge-work-'));
  try {
    const cloneDir = join(work, 'first');
    await git(['clone', `${base}/adaiversen/cli-repo.git`, cloneDir], work);
    await git(['config', 'user.name', 'Ada Iversen'], cloneDir);
    await git(['config', 'user.email', 'adaiversen@example.invalid'], cloneDir);
    await writeFile(join(cloneDir, 'hello.txt'), 'hello from git\n', 'utf8');
    await git(['add', 'hello.txt'], cloneDir);
    await git(['commit', '-m', 'first commit'], cloneDir);
    await git(['push', 'origin', 'main'], cloneDir);

    const secondDir = join(work, 'second');
    await git(['clone', `${base}/adaiversen/cli-repo.git`, secondDir], work);
    assert.equal(await readFile(join(secondDir, 'hello.txt'), 'utf8'), 'hello from git\n');

    await writeFile(join(cloneDir, 'second.txt'), 'second file\n', 'utf8');
    await git(['add', 'second.txt'], cloneDir);
    await git(['commit', '-m', 'second commit'], cloneDir);
    await git(['push', 'origin', 'main'], cloneDir);
    await git(['pull', '--ff-only'], secondDir);
    assert.equal(await readFile(join(secondDir, 'second.txt'), 'utf8'), 'second file\n');

    const shallowDir = join(work, 'shallow');
    await git(['clone', '--depth', '1', `${base}/adaiversen/cli-repo.git`, shallowDir], work);
    assert.equal(await readFile(join(shallowDir, 'hello.txt'), 'utf8'), 'hello from git\n');
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});
