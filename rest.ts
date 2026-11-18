// rest.ts — the REST v3 surface: repositories, branches, commits, contents,
// labels, issues, comments and pull requests.
//
// Every reply is JSON with a non-empty X-GitHub-Request-Id (the app layer
// adds the header); errors carry a string `message`. Shapes follow GitHub's
// v3 API as the suite reads them: the fields the checks assert are all here,
// plus the usual GitHub neighbours so the objects look like the real thing.

import { isOid } from './git.ts';
import {
  type CommentRecord,
  type ForgeStore,
  type IssueRecord,
  type LabelRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';

export interface RestReply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

function err(status: number, message: string): RestReply {
  return { status, body: { message, documentation_url: 'https://docs.github.com/rest' } };
}

export function userJson(store: ForgeStore): Record<string, unknown> {
  const viewer = store.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: Buffer.from(`User:${viewer.id}`, 'utf8').toString('base64'),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: viewer.name,
    email: viewer.email,
    html_url: `https://github.com/${viewer.login}`,
    url: `/api/v3/users/${viewer.login}`,
  };
}

function ownerJson(store: ForgeStore, repo: RepoRecord): Record<string, unknown> {
  return {
    login: repo.owner,
    id: store.viewer.id,
    node_id: Buffer.from(`User:${store.viewer.id}`, 'utf8').toString('base64'),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    html_url: `https://github.com/${repo.owner}`,
    url: `/api/v3/users/${repo.owner}`,
  };
}

export function repoJson(store: ForgeStore, repo: RepoRecord, base: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const stamp = store.nowIso();
  return {
    id: repo.dbId,
    node_id: store.repoGlobalId(repo),
    name: repo.name,
    full_name: fullName,
    owner: ownerJson(store, repo),
    private: repo.isPrivate,
    html_url: `${base}/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${fullName}`,
    created_at: stamp,
    updated_at: stamp,
    pushed_at: stamp,
    git_url: `${base}/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
    clone_url: `${base}/${fullName}.git`,
    svn_url: `${base}/${fullName}`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: store.openCount(repo),
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: store.openCount(repo),
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function labelJson(_store: ForgeStore, repo: RepoRecord, label: LabelRecord, base: string): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${repo.dbId}:${label.id}`, 'utf8').toString('base64'),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(store: ForgeStore, repo: RepoRecord, issue: IssueRecord, base: string): Record<string, unknown> {
  const stamp = store.nowIso();
  return {
    id: issue.id,
    node_id: store.issueGlobalId(repo, issue),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: {
      login: issue.authorLogin,
      id: store.viewer.id,
      node_id: Buffer.from(`User:${store.viewer.id}`, 'utf8').toString('base64'),
      avatar_url: '',
      type: 'User',
      site_admin: false,
    },
    labels: issue.labels.map((label) => labelJson(store, repo, label, base)),
    assignees: [],
    locked: false,
    assignee: null,
    comments: issue.comments.length,
    created_at: stamp,
    updated_at: stamp,
    closed_at: issue.state === 'closed' ? stamp : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function commentJson(store: ForgeStore, repo: RepoRecord, issue: IssueRecord, comment: CommentRecord, base: string): Record<string, unknown> {
  const stamp = store.nowIso();
  return {
    id: comment.id,
    node_id: store.commentGlobalId(repo, comment),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: {
      login: comment.authorLogin,
      id: store.viewer.id,
      node_id: Buffer.from(`User:${store.viewer.id}`, 'utf8').toString('base64'),
      avatar_url: '',
      type: 'User',
      site_admin: false,
    },
    created_at: stamp,
    updated_at: stamp,
    author_association: 'OWNER',
  };
}

export function pullJson(store: ForgeStore, repo: RepoRecord, pull: PullRecord, base: string): Record<string, unknown> {
  const stamp = store.nowIso();
  const { headSha, baseSha } = store.pullTips(repo, pull);
  const mergeable = store.pullMergeable(repo, pull);
  const refJson = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: {
      login: repo.owner,
      id: store.viewer.id,
      node_id: Buffer.from(`User:${store.viewer.id}`, 'utf8').toString('base64'),
      avatar_url: '',
      type: 'User',
      site_admin: false,
    },
    repo: {
      id: repo.dbId,
      node_id: store.repoGlobalId(repo),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: ownerJson(store, repo),
      private: repo.isPrivate,
      html_url: `${base}/${repo.owner}/${repo.name}`,
      description: repo.description,
      fork: false,
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
      default_branch: repo.defaultBranch,
    },
  });
  return {
    id: pull.id,
    node_id: store.pullGlobalId(repo, pull),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: {
      login: pull.authorLogin,
      id: store.viewer.id,
      node_id: Buffer.from(`User:${store.viewer.id}`, 'utf8').toString('base64'),
      avatar_url: '',
      type: 'User',
      site_admin: false,
    },
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: stamp,
    updated_at: stamp,
    closed_at: pull.state === 'closed' ? stamp : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: refJson(pull.headRef, headSha),
    base: refJson(pull.baseRef, baseSha),
    merged: pull.merged,
    mergeable: pull.state === 'open' ? mergeable === 'MERGEABLE' : null,
    rebaseable: null,
    mergeable_state: pull.state === 'open' ? (mergeable === 'MERGEABLE' ? 'clean' : mergeable === 'CONFLICTING' ? 'dirty' : 'unknown') : 'unknown',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`,
    review_comments_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/comments`,
    comments_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`,
    statuses_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/statuses/${headSha}`,
    draft: false,
    author_association: 'OWNER',
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;

function asRecord(value: unknown): Body | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Body) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function validRepoName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.endsWith('.git');
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

/** A Link header for the next page, same-origin, only when one exists. */
function nextLink(base: string, path: string, query: URLSearchParams, page: number, perPage: number): string | null {
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  return `<${base}${path}?${next.toString()}>; rel="next"`;
}

// ---------------------------------------------------------------------------
// route handlers: each takes the store, the decoded path segments after
// /api/v3, the query, the parsed JSON body (or null) and the request base.
// ---------------------------------------------------------------------------

export function handleRest(
  store: ForgeStore,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  base: string,
): RestReply {
  const [first, second, third] = segments;

  // API root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { current_user_url: `${base}/api/v3/user` }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (first === 'meta' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      git: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      installed_version: '1.0.0',
    });
  }
  if (first === 'user' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, userJson(store));
  }

  // /user/repos: list and create.
  if (first === 'user' && second === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const { page, perPage } = parsePage(query);
      const all = store.listRepos(store.viewer.login);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const link = nextLink(base, '/api/v3/user/repos', query, page, perPage);
        if (link) headers.Link = link;
      }
      return ok(200, slice.map((repo) => repoJson(store, repo, base)), headers);
    }
    if (method === 'POST') {
      const record = asRecord(body);
      if (!record) return err(422, 'body must be a JSON object');
      const name = asString(record.name);
      if (!name || !validRepoName(name)) return err(422, 'name is invalid');
      const description = asString(record.description) ?? '';
      const isPrivate = record.private === true;
      const repo = store.createRepo(store.viewer.login, name, description, isPrivate);
      if (!repo) return err(422, 'name already exists on this account');
      return ok(201, repoJson(store, repo, base));
    }
    return err(404, 'Not Found');
  }

  // /repos/{owner}/{repo}[...]
  if (first === 'repos' && second !== undefined && third !== undefined) {
    const owner = second;
    const name = third;
    const repo = store.getRepo(owner, name);
    if (!repo) return err(404, 'Not Found');
    const tail = segments.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') return ok(200, repoJson(store, repo, base));
      if (method === 'PATCH') {
        const record = asRecord(body);
        if (!record) return err(422, 'body must be a JSON object');
        if (typeof record.description === 'string') repo.description = record.description;
        if (typeof record.private === 'boolean') repo.isPrivate = record.private;
        return ok(200, repoJson(store, repo, base));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    const [resource, ...resourceTail] = tail;
    if (resource === 'branches') return handleBranches(store, repo, method, resourceTail, base);
    if (resource === 'commits') return handleCommits(store, repo, method, resourceTail, query, base);
    if (resource === 'git') return handleGitData(store, repo, method, resourceTail, body, base);
    if (resource === 'contents') return handleContents(store, repo, method, resourceTail, query, body, base);
    if (resource === 'labels') return handleLabels(store, repo, method, resourceTail, body, base);
    if (resource === 'issues') return handleIssues(store, repo, method, resourceTail, query, body, base);
    if (resource === 'pulls') return handlePulls(store, repo, method, resourceTail, query, body, base);
    return err(404, 'Not Found');
  }

  if (first === 'repos') return err(404, 'Not Found');
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// branches
// ---------------------------------------------------------------------------

// Commit objects store the git-conventional trailing newline; the API
// presents the message the way GitHub does, with trailing line breaks off.
function displayMessage(message: string): string {
  return message.replace(/[\r\n]+$/, '');
}

function branchJson(store: ForgeStore, repo: RepoRecord, name: string, sha: string, base: string): Record<string, unknown> {
  const info = store.commitInfo(repo, sha);
  return {
    name,
    commit: {
      sha,
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
      commit: info ? { message: displayMessage(info.message), author: { name: store.viewer.name, email: store.viewer.email } } : undefined,
    },
    protected: false,
  };
}

function handleBranches(store: ForgeStore, repo: RepoRecord, method: string, tail: string[], base: string): RestReply {
  if (method === 'GET' && tail.length === 0) {
    const branches = store
      .listRefs(repo)
      .filter((ref) => ref.name.startsWith('refs/heads/'))
      .map((ref) => branchJson(store, repo, ref.name.slice('refs/heads/'.length), ref.oid, base));
    return ok(200, branches);
  }
  if (method === 'GET' && tail.length >= 1) {
    const branch = tail.join('/');
    const sha = store.getRef(repo, `refs/heads/${branch}`);
    if (!sha) return err(404, 'Branch not found');
    return ok(200, branchJson(store, repo, branch, sha, base));
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------

function commitJson(store: ForgeStore, repo: RepoRecord, sha: string, base: string): Record<string, unknown> | null {
  const info = store.commitInfo(repo, sha);
  if (!info) return null;
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`, 'utf8').toString('base64'),
    commit: {
      author: { name: store.viewer.name, email: store.viewer.email, date: store.nowIso() },
      committer: { name: store.viewer.name, email: store.viewer.email, date: store.nowIso() },
      message: displayMessage(info.message),
      tree: { sha: info.tree, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${info.tree}` },
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned' },
    },
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${sha}`,
    author: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    committer: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    parents: info.parents.map((parent) => ({ sha: parent, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
  };
}

function handleCommits(store: ForgeStore, repo: RepoRecord, method: string, tail: string[], query: URLSearchParams, base: string): RestReply {
  if (method !== 'GET') return err(404, 'Not Found');
  if (tail.length === 1) {
    const sha = store.resolveRef(repo, tail[0] as string);
    if (!sha) return err(404, 'Not Found');
    const view = commitJson(store, repo, sha, base);
    return view ? ok(200, view) : err(404, 'Not Found');
  }
  if (tail.length === 0) {
    const refish = query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, refish);
    if (!tip) return err(404, 'Not Found');
    const list = store.listCommits(repo, tip);
    const views: unknown[] = [];
    for (const sha of list) {
      const view = commitJson(store, repo, sha, base);
      if (view) views.push(view);
    }
    return ok(200, views);
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// git data: refs
// ---------------------------------------------------------------------------

function handleGitData(store: ForgeStore, repo: RepoRecord, method: string, tail: string[], body: unknown, base: string): RestReply {
  const [resource, ...rest] = tail;
  if (resource !== 'refs') return err(404, 'Not Found');
  if (method === 'GET' && rest.length === 0) {
    return ok(
      200,
      store.listRefs(repo).map((ref) => ({
        ref: ref.name,
        node_id: Buffer.from(`Ref:${ref.name}`, 'utf8').toString('base64'),
        url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/${ref.name}`,
        object: { sha: ref.oid, type: store.getObject(repo, ref.oid)?.type ?? 'commit', url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${ref.oid}` },
      })),
    );
  }
  if (method === 'GET' && rest.length >= 1) {
    const refName = `refs/${rest.join('/')}`;
    const sha = store.getRef(repo, refName);
    if (!sha) return err(404, 'Not Found');
    return ok(200, {
      ref: refName,
      node_id: Buffer.from(`Ref:${refName}`, 'utf8').toString('base64'),
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/${refName}`,
      object: { sha, type: store.getObject(repo, sha)?.type ?? 'commit', url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
    });
  }
  if (method === 'POST' && rest.length === 0) {
    const record = asRecord(body);
    if (!record) return err(422, 'body must be a JSON object');
    const ref = asString(record.ref);
    const sha = asString(record.sha);
    if (!ref || !ref.startsWith('refs/') || !sha || !isOid(sha)) return err(422, 'ref and sha are required');
    if (!store.getObject(repo, sha)) return err(422, 'sha does not exist');
    if (store.getRef(repo, ref) !== undefined) return err(422, 'ref already exists');
    store.setRef(repo, ref, sha);
    return ok(201, {
      ref,
      node_id: Buffer.from(`Ref:${ref}`, 'utf8').toString('base64'),
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/${ref}`,
      object: { sha, type: store.getObject(repo, sha)?.type ?? 'commit', url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
    });
  }
  if (method === 'PATCH' && rest.length >= 1) {
    const refName = `refs/${rest.join('/')}`;
    const record = asRecord(body);
    const sha = record ? asString(record.sha) : null;
    if (!sha || !isOid(sha) || !store.getObject(repo, sha)) return err(422, 'sha does not exist');
    if (store.getRef(repo, refName) === undefined) return err(404, 'Not Found');
    store.setRef(repo, refName, sha);
    return ok(200, {
      ref: refName,
      node_id: Buffer.from(`Ref:${refName}`, 'utf8').toString('base64'),
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/${refName}`,
      object: { sha, type: store.getObject(repo, sha)?.type ?? 'commit', url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
    });
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function contentsFileJson(store: ForgeStore, repo: RepoRecord, path: string, oid: string, base: string): Record<string, unknown> {
  const blob = store.getObject(repo, oid);
  const data = blob?.data ?? Buffer.alloc(0);
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: oid,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${oid}`,
    html_url: `${base}/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
    download_url: null,
    _links: { git: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${oid}`, self: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`, html: `${base}/${repo.owner}/${repo.name}/blob/HEAD/${path}` },
  };
}

function handleContents(
  store: ForgeStore,
  repo: RepoRecord,
  method: string,
  tail: string[],
  query: URLSearchParams,
  body: unknown,
  base: string,
): RestReply {
  const rawPath = tail.join('/');
  const path = store.normalizePath(rawPath);
  if (path === null) return err(422, 'invalid path');
  const refish = query.get('ref') ?? undefined;

  if (method === 'GET') {
    const tip = store.resolveRef(repo, refish ?? repo.defaultBranch);
    if (!tip) return err(404, 'Not Found');
    const found = store.readPath(repo, tip, path);
    if (!found) return err(404, 'Not Found');
    if (found.kind === 'file') return ok(200, contentsFileJson(store, repo, path, found.oid, base));
    return ok(
      200,
      found.entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        size: entry.mode === '40000' ? 0 : (store.getObject(repo, entry.oid)?.data.length ?? 0),
        name: entry.name,
        path: entry.path,
        sha: entry.oid,
        url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.path}`,
        git_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${entry.oid}`,
        html_url: `${base}/${repo.owner}/${repo.name}/tree/HEAD/${entry.path}`,
        download_url: null,
        _links: {},
      })),
    );
  }

  if (method === 'PUT' || method === 'DELETE') {
    const record = asRecord(body);
    if (!record) return err(422, 'body must be a JSON object');
    const message = asString(record.message) ?? '';
    // The branch rides in the body on real GitHub and in the query string
    // in the conformance suite; accept either, body first.
    const branch = asString(record.branch) ?? query.get('branch') ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    let tip = store.getRef(repo, refName);
    if (tip === undefined) {
      // A write to a new branch starts from the default branch's tip.
      const defaultTip = store.getRef(repo, `refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined) tip = defaultTip;
    }
    const expectedSha = asString(record.sha) ?? null;

    if (method === 'PUT') {
      const contentB64 = asString(record.content);
      if (contentB64 === null) return err(422, 'content is required');
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        return err(422, 'content is not valid base64');
      }
      const current = tip === undefined ? null : store.readPath(repo, tip, path);
      const existed = current !== null && current.kind === 'file';
      if (existed && expectedSha === null) return err(409, 'file already exists');
      if (existed && expectedSha !== null && (current as { oid: string }).oid !== expectedSha) {
        return err(409, 'sha does not match the current file');
      }
      if (!existed && expectedSha !== null) return err(404, 'Not Found');
      const blobOid = store.putObject(repo, 'blob', content);
      const baseInfo = tip === undefined ? null : store.commitInfo(repo, tip);
      const flat = baseInfo ? store.flattenTree(repo, baseInfo.tree) : new Map<string, { oid: string; mode: string }>();
      flat.set(path, { oid: blobOid, mode: '100644' });
      const tree = store.buildTreeFromMap(repo, flat);
      const parents = tip === undefined ? [] : [tip];
      const commitSha = store.createCommit(repo, tree, parents, message);
      store.setRef(repo, refName, commitSha);
      const status = existed ? 200 : 201;
      return ok(status, {
        content: contentsFileJson(store, repo, path, blobOid, base),
        commit: { sha: commitSha, message, author: { name: store.viewer.name, email: store.viewer.email }, committer: { name: store.viewer.name, email: store.viewer.email } },
      });
    }

    // DELETE
    if (tip === undefined) return err(404, 'Not Found');
    const current = store.readPath(repo, tip, path);
    if (!current || current.kind !== 'file') return err(404, 'Not Found');
    if (expectedSha !== null && current.oid !== expectedSha) return err(409, 'sha does not match the current file');
    const info = store.commitInfo(repo, tip);
    if (!info) return err(404, 'Not Found');
    const flat = store.flattenTree(repo, info.tree);
    flat.delete(path);
    const tree = store.buildTreeFromMap(repo, flat);
    const commitSha = store.createCommit(repo, tree, [tip], message);
    store.setRef(repo, refName, commitSha);
    return ok(200, {
      commit: { sha: commitSha, message, author: { name: store.viewer.name, email: store.viewer.email }, committer: { name: store.viewer.name, email: store.viewer.email } },
    });
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

function handleLabels(store: ForgeStore, repo: RepoRecord, method: string, tail: string[], body: unknown, base: string): RestReply {
  if (method === 'GET' && tail.length === 0) {
    return ok(200, [...repo.labels.values()].map((label) => labelJson(store, repo, label, base)));
  }
  if (method === 'POST' && tail.length === 0) {
    const record = asRecord(body);
    if (!record) return err(422, 'body must be a JSON object');
    const name = asString(record.name);
    if (!name) return err(422, 'name is required');
    const color = asString(record.color) ?? 'ededed';
    const description = asString(record.description) ?? '';
    const label = store.createLabel(repo, name, color, description);
    if (!label) return err(422, 'label already exists');
    return ok(201, labelJson(store, repo, label, base));
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

function handleIssues(
  store: ForgeStore,
  repo: RepoRecord,
  method: string,
  tail: string[],
  query: URLSearchParams,
  body: unknown,
  base: string,
): RestReply {
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      return ok(200, issues.map((issue) => issueJson(store, repo, issue, base)));
    }
    if (method === 'POST') {
      const record = asRecord(body);
      if (!record) return err(422, 'body must be a JSON object');
      const title = asString(record.title);
      if (!title) return err(422, 'title is required');
      const bodyText = typeof record.body === 'string' ? record.body : null;
      const labelNames = Array.isArray(record.labels)
        ? record.labels.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const created = store.createIssue(repo, title, bodyText, labelNames);
      if ('unknownLabel' in created) return err(422, `label does not exist: ${created.unknownLabel}`);
      return ok(201, issueJson(store, repo, created.issue, base));
    }
    return err(404, 'Not Found');
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return err(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') return ok(200, issueJson(store, repo, issue, base));
    if (method === 'PATCH') {
      const record = asRecord(body);
      if (!record) return err(422, 'body must be a JSON object');
      if (typeof record.title === 'string') issue.title = record.title;
      if (typeof record.body === 'string' || record.body === null) issue.body = record.body as string | null;
      if (record.state === 'open' || record.state === 'closed') issue.state = record.state;
      if (Array.isArray(record.labels)) {
        const names = record.labels.filter((entry): entry is string => typeof entry === 'string');
        const labels: LabelRecord[] = [];
        for (const name of names) {
          const label = repo.labels.get(name);
          if (!label) return err(422, `label does not exist: ${name}`);
          labels.push(label);
        }
        issue.labels = labels;
      }
      return ok(200, issueJson(store, repo, issue, base));
    }
    return err(404, 'Not Found');
  }

  if (tail[1] === 'comments' && tail.length === 2) {
    if (method === 'GET') {
      return ok(200, issue.comments.map((comment) => commentJson(store, repo, issue, comment, base)));
    }
    if (method === 'POST') {
      const record = asRecord(body);
      if (!record) return err(422, 'body must be a JSON object');
      const text = asString(record.body);
      if (text === null) return err(422, 'body is required');
      const comment = store.addComment(repo, issue, text);
      return ok(201, commentJson(store, repo, issue, comment, base));
    }
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

function handlePulls(
  store: ForgeStore,
  repo: RepoRecord,
  method: string,
  tail: string[],
  query: URLSearchParams,
  body: unknown,
  base: string,
): RestReply {
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => a.createdSeq - b.createdSeq);
      return ok(200, pulls.map((pull) => pullJson(store, repo, pull, base)));
    }
    if (method === 'POST') {
      const record = asRecord(body);
      if (!record) return err(422, 'body must be a JSON object');
      const title = asString(record.title);
      const head = asString(record.head);
      const baseRef = asString(record.base);
      if (!title || !head || !baseRef) return err(422, 'title, head and base are required');
      const headSha = store.resolveRef(repo, head);
      const baseSha = store.resolveRef(repo, baseRef);
      if (!headSha) return err(422, `head branch does not exist: ${head}`);
      if (!baseSha) return err(422, `base branch does not exist: ${baseRef}`);
      const bodyText = typeof record.body === 'string' ? record.body : null;
      const pull = store.createPull(repo, title, bodyText, head, baseRef, headSha, baseSha);
      return ok(201, pullJson(store, repo, pull, base));
    }
    return err(404, 'Not Found');
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return err(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') return ok(200, pullJson(store, repo, pull, base));
    return err(404, 'Not Found');
  }

  if (tail[1] === 'files' && tail.length === 2 && method === 'GET') {
    const changes = store.pullFiles(repo, pull);
    return ok(
      200,
      changes.map((change) => ({
        sha: change.newOid ?? change.oldOid ?? '',
        filename: change.path,
        status: change.status === 'modified' ? 'modified' : change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.additions + change.deletions,
        blob_url: `${base}/${repo.owner}/${repo.name}/blob/HEAD/${change.path}`,
        raw_url: `${base}/${repo.owner}/${repo.name}/raw/HEAD/${change.path}`,
        contents_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${change.path}`,
        patch: '',
      })),
    );
  }

  if (tail[1] === 'merge' && tail.length === 2 && method === 'PUT') {
    if (pull.state !== 'open') return err(405, 'pull request is not open');
    const sha = store.mergePull(repo, pull);
    if (sha === null) return err(405, 'merge conflict: the pull request cannot be merged cleanly');
    return ok(200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return err(404, 'Not Found');
}
