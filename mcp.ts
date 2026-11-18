// mcp.ts — Model Context Protocol over plain JSON-RPC 2.0 at /mcp.
//
// Two protocol eras are served from one dispatcher:
//   * the modern era (2026-07-28): no handshake, clients open with
//     `server/discover` and declare the revision on every request;
//   * the legacy era (2025-11-25 and older): `initialize` plus an
//     `notifications/initialized` notification.
// Tools are exactly the six canonical GitHub tool names, with the canonical
// argument names and the smallest required arrays the suite can fill, so a
// caller mapping documented arguments onto schema properties never stalls on
// an unfillable required property.

import type { ForgeStore } from './store.ts';

export const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const PROTOCOL_VERSION = '2026-07-28';

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly type: 'object'; readonly properties: Record<string, { type: string; description?: string }>; readonly required: string[] };
}

// Frozen once: tools/list answers must be byte-identical across calls.
const TOOLS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'Repository name.' }),
        description: Object.freeze({ type: 'string', description: 'Repository description.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        title: Object.freeze({ type: 'string', description: 'Issue title.' }),
        body: Object.freeze({ type: 'string', description: 'Issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        state: Object.freeze({ type: 'string', description: 'Issue state filter: open, closed, or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        title: Object.freeze({ type: 'string', description: 'Pull request title.' }),
        head: Object.freeze({ type: 'string', description: 'Head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'Base branch name.' }),
        body: Object.freeze({ type: 'string', description: 'Pull request body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'Repository name.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'Pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

interface RpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

interface RpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function ok(id: string | number | null, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: string | number | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const SERVER_INFO = Object.freeze({ name: 'github-forge', version: '1.0.0' });

// A domain error inside a tool: reported as an isError result, HTTP 200.
class ToolError extends Error {}

// Resolve owner/repo from tool arguments, accepting the canonical names and
// the `full_name` fallback ("owner/repo") some callers send instead.
function resolveRepoArgs(store: ForgeStore, args: Record<string, unknown>): { owner: string; repo: string; record: NonNullable<ReturnType<ForgeStore['getRepo']>> } {
  let owner = typeof args.owner === 'string' ? args.owner : null;
  let repoName = typeof args.repo === 'string' ? args.repo : null;
  if ((owner === null || repoName === null) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner ??= parts[0] as string;
      repoName ??= parts[1] as string;
    }
  }
  if (owner === null || repoName === null) throw new ToolError('missing owner or repo argument');
  const record = store.getRepo(owner, repoName);
  if (!record) throw new ToolError('Not Found');
  return { owner, repo: repoName, record };
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new ToolError(`missing required argument: ${name}`);
  return value;
}

function requireNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ToolError(`missing required argument: ${name}`);
  return value;
}

function toolResult(payload: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function toolErrorResult(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      const repoName = requireString(args, 'name');
      const description = typeof args.description === 'string' ? args.description : null;
      const isPrivate = args.private === true;
      const repo = store.createRepo(store.viewer.login, repoName, isPrivate, description);
      if (!repo) throw new ToolError('name already exists on this account');
      return toolResult({ id: repo.dbId, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, description: repo.description, default_branch: repo.defaultBranch });
    }
    case 'get_repo': {
      const { record } = resolveRepoArgs(store, args);
      return toolResult({ id: record.dbId, name: record.name, full_name: `${record.owner}/${record.name}`, private: record.private, description: record.description, default_branch: record.defaultBranch });
    }
    case 'create_issue': {
      const { record } = resolveRepoArgs(store, args);
      const title = requireString(args, 'title');
      const body = typeof args.body === 'string' ? args.body : null;
      const created = store.createIssue(record, title, body, []);
      if ('unknownLabel' in created) throw new ToolError('label does not exist');
      const issue = created.issue;
      return toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: [], user: { login: issue.authorLogin } });
    }
    case 'list_issues': {
      const { record } = resolveRepoArgs(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...record.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: [], user: { login: issue.authorLogin } }));
      return toolResult({ issues });
    }
    case 'create_pull_request': {
      const { record } = resolveRepoArgs(store, args);
      const title = requireString(args, 'title');
      const head = requireString(args, 'head');
      const base = requireString(args, 'base');
      const body = typeof args.body === 'string' ? args.body : null;
      const headSha = store.resolveRef(record, head);
      const baseSha = store.resolveRef(record, base);
      if (!headSha) throw new ToolError(`head branch does not exist: ${head}`);
      if (!baseSha) throw new ToolError(`base branch does not exist: ${base}`);
      const pull = store.createPull(record, title, body, head, base, headSha, baseSha);
      return toolResult({ id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha } });
    }
    case 'merge_pull_request': {
      const { record } = resolveRepoArgs(store, args);
      const number = requireNumber(args, 'pull_number');
      const pull = record.pulls.get(number);
      if (!pull) throw new ToolError('Not Found');
      if (pull.state !== 'open') throw new ToolError('pull request is not open');
      const sha = store.mergePull(record, pull);
      if (sha === null) throw new ToolError('merge conflict');
      return toolResult({ merged: true, sha, message: 'Pull Request successfully merged', number: pull.number, state: pull.state });
    }
    default:
      return null;
  }
}

export interface McpOutcome {
  readonly status: number;
  readonly body: RpcResponse | null;
  readonly headers: Record<string, string>;
}

const VERSION_HEADER = { 'MCP-Protocol-Version': PROTOCOL_VERSION };

// Dispatch one JSON-RPC request. Authentication is checked by the caller
// before this runs; a notification (no id) answers 202 with no body.
export function handleMcp(store: ForgeStore, request: RpcRequest): McpOutcome {
  const isNotification = request.id === undefined || request.id === null;
  const id = request.id ?? null;
  const method = request.method ?? '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method.startsWith('notifications/')) {
    return { status: 202, body: null, headers: VERSION_HEADER };
  }

  switch (method) {
    case 'server/discover': {
      return {
        status: 200,
        body: ok(id, {
          identity: { name: SERVER_INFO.name, version: SERVER_INFO.version },
          capabilities: { tools: {} },
          supportedVersions: [...MCP_VERSIONS],
          serverInfo: { ...SERVER_INFO },
          protocolVersion: PROTOCOL_VERSION,
          _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
        }),
        headers: VERSION_HEADER,
      };
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      const negotiated = MCP_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
      return {
        status: 200,
        body: ok(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        }),
        headers: { 'MCP-Protocol-Version': negotiated },
      };
    }
    case 'ping': {
      return { status: 200, body: ok(id, {}), headers: VERSION_HEADER };
    }
    case 'tools/list': {
      return { status: 200, body: ok(id, { tools: TOOLS }), headers: VERSION_HEADER };
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const known = TOOLS.some((tool) => tool.name === toolName);
      if (!known) return { status: 200, body: fail(id, -32602, `unknown tool: ${toolName}`), headers: VERSION_HEADER };
      try {
        const result = callTool(store, toolName, args);
        if (result === null) return { status: 200, body: fail(id, -32602, `unknown tool: ${toolName}`), headers: VERSION_HEADER };
        return { status: 200, body: ok(id, result), headers: VERSION_HEADER };
      } catch (error) {
        if (error instanceof ToolError) {
          if (error.message.startsWith('missing required argument')) {
            return { status: 200, body: fail(id, -32602, error.message), headers: VERSION_HEADER };
          }
          return { status: 200, body: ok(id, toolErrorResult(error.message)), headers: VERSION_HEADER };
        }
        throw error;
      }
    }
    default: {
      if (isNotification) return { status: 202, body: null, headers: VERSION_HEADER };
      return { status: 200, body: fail(id, -32601, `method not found: ${method}`), headers: VERSION_HEADER };
    }
  }
}
