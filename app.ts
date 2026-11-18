// app.ts — the HTTP front door.
//
// One node:http server routes four surfaces onto one in-memory store:
// git smart HTTP under /{owner}/{repo}.git, REST v3 under /api/v3,
// GraphQL at /api/graphql and MCP at /mcp. Every reply carries a non-empty
// X-GitHub-Request-Id; every JSON reply uses application/json; unknown
// routes and malformed bodies answer JSON errors, never HTML and never a
// crash — the server must survive hostile input and keep serving.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { infoRefs, receivePack, uploadPack, type GitResponse } from './git-http.ts';
import type { ForgeStore } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

export interface ForgeServerOptions {
  readonly store: ForgeStore;
  /** Bearer token clients must present; empty means "accept anything" (dev). */
  readonly expectedToken: string;
}

function requestIdHeader(counter: number): string {
  return `req-${counter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': payload.length,
    'x-github-request-id': requestId,
    ...extra,
  });
  res.end(payload);
}

function sendGit(res: ServerResponse, requestId: string, response: GitResponse): void {
  res.writeHead(response.status, {
    'content-type': response.contentType,
    'content-length': response.body.length,
    'x-github-request-id': requestId,
  });
  res.end(response.body);
}

function readBody(req: IncomingMessage): Promise<Buffer | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        done = true;
        resolve('too-large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!done) reject(error);
    });
  });
}

function authorized(req: IncomingMessage, expectedToken: string): boolean {
  if (expectedToken === '') return true;
  const header = req.headers.authorization;
  return header === `Bearer ${expectedToken}`;
}

function decodeSegments(pathname: string): string[] | null {
  const parts = pathname.split('/').filter((part) => part !== '');
  const decoded: string[] = [];
  for (const part of parts) {
    try {
      decoded.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return decoded;
}

export function createForgeServer(options: ForgeServerOptions): Server {
  const { store, expectedToken } = options;
  let requestCounter = 0;

  const server = createServer((req, res) => {
    void (async () => {
      requestCounter += 1;
      const requestId = requestIdHeader(requestCounter);
      try {
        const url = new URL(req.url ?? '/', 'http://forge.invalid');
        const segments = decodeSegments(url.pathname);
        if (segments === null) {
          sendJson(res, requestId, 400, { message: 'Bad Request' });
          return;
        }
        const method = (req.method ?? 'GET').toUpperCase();

        // Health check: no auth, no body.
        if (segments.length === 1 && segments[0] === 'healthz') {
          if (method !== 'GET') {
            sendJson(res, requestId, 404, { message: 'Not Found' });
            return;
          }
          sendJson(res, requestId, 200, { ok: true });
          return;
        }

        const rawBody = await readBody(req);
        if (rawBody === 'too-large') {
          sendJson(res, requestId, 413, { message: 'Request Entity Too Large' });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs and
        // /{owner}/{repo}.git/{git-upload-pack,git-receive-pack}.
        // The .git suffix is optional; both shapes resolve the same repo.
        const isInfoRefs = segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs';
        const isSmartService = segments.length === 3 && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack');
        if (isInfoRefs || isSmartService) {
          if (!authorized(req, expectedToken)) {
            sendJson(res, requestId, 401, { message: 'Bad credentials' });
            return;
          }
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).replace(/\.git$/, '');
          const repo = store.getRepo(owner, repoName);
          const gitProtocol = String(req.headers['git-protocol'] ?? '');
          if (isInfoRefs) {
            const service = url.searchParams.get('service') ?? '';
            sendGit(res, requestId, infoRefs(store, repo, service, gitProtocol.includes('version=2')));
            return;
          }
          if (method !== 'POST') {
            sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (segments[2] === 'git-upload-pack') {
            sendGit(res, requestId, uploadPack(store, repo, rawBody, gitProtocol.includes('version=2')));
          } else {
            sendGit(res, requestId, receivePack(store, repo, rawBody));
          }
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!authorized(req, expectedToken)) {
            sendJson(res, requestId, 401, { message: 'Bad credentials' });
            return;
          }
          const body = parseJsonBody(rawBody);
          if (body === 'malformed') {
            sendJson(res, requestId, 400, { message: 'Problems parsing JSON' });
            return;
          }
          const base = `http://${req.headers.host ?? '127.0.0.1'}`;
          const reply = handleRest(store, method, segments.slice(2), url.searchParams, body, base);
          sendJson(res, requestId, reply.status, reply.body, reply.headers ?? {});
          return;
        }

        // GraphQL.
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (!authorized(req, expectedToken)) {
            sendJson(res, requestId, 401, { message: 'Bad credentials' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = parseJsonBody(rawBody);
          if (body === 'malformed' || body === null || typeof body !== 'object') {
            sendJson(res, requestId, 400, { message: 'Problems parsing JSON' });
            return;
          }
          if (Array.isArray(body)) {
            const results = body.map((item) => runOneGraphQL(store, item));
            sendJson(res, requestId, 200, results);
            return;
          }
          sendJson(res, requestId, 200, runOneGraphQL(store, body));
          return;
        }

        // MCP.
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (!authorized(req, expectedToken)) {
            sendJson(res, requestId, 401, { message: 'Bad credentials' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = parseJsonBody(rawBody);
          if (body === 'malformed' || body === null || typeof body !== 'object' || Array.isArray(body)) {
            sendJson(
              res,
              requestId,
              400,
              { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
              { 'MCP-Protocol-Version': '2026-07-28' },
            );
            return;
          }
          const outcome = handleMcp(store, body as { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> });
          if (outcome.body === null) {
            res.writeHead(outcome.status, { 'x-github-request-id': requestId, ...outcome.headers });
            res.end();
            return;
          }
          sendJson(res, requestId, outcome.status, outcome.body, outcome.headers);
          return;
        }

        sendJson(res, requestId, 404, { message: 'Not Found' });
      } catch (error) {
        // Never let one bad request kill the process.
        if (!res.headersSent) {
          sendJson(res, requestId, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });

  return server;
}

function parseJsonBody(raw: Buffer): unknown | 'malformed' {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return 'malformed';
  }
}

function runOneGraphQL(store: ForgeStore, item: unknown): unknown {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return { data: null, errors: [{ message: 'request body must be an object' }] };
  }
  const record = item as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
  return executeGraphQL(store, query, variables, operationName);
}
