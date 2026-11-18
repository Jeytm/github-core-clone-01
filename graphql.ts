// graphql.ts — a small GraphQL executor for the documents gh and
// github-mcp-server send: queries, mutations, variables, aliases, inline and
// named fragments, input objects, enum literals and batched bodies.
//
// No GraphQL library exists in the stdlib, so this file lexes, parses and
// executes the fixed schema surface directly. Unknown fields are GraphQL
// errors (HTTP 200 with an `errors` array naming the field), never HTTP
// errors; an unknown repository reads `data.repository = null` with no errors.

import type { ForgeStore, IssueRecord, PullRecord, RepoRecord } from './store.ts';

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < source.length) {
        const c = source[j] as string;
        if (c === '"') {
          closed = true;
          j += 1;
          break;
        }
        if (c === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u' && j + 5 < source.length) {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else if (simple[esc] !== undefined) {
            out += simple[esc];
            j += 2;
          } else {
            out += esc;
            j += 2;
          }
          continue;
        }
        out += c;
        j += 1;
      }
      if (!closed) throw new Error('unterminated string in GraphQL document');
      tokens.push({ kind: 'string', value: out });
      i = j;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        let k = j + 1;
        if (source[k] === '+' || source[k] === '-') k += 1;
        if (/[0-9]/.test(source[k] ?? '')) {
          isFloat = true;
          j = k;
          while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: ValueNode[] }
  | { readonly kind: 'object'; readonly fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selectionSet: SelectionNode[] | null;
}

interface SpreadNode {
  readonly kind: 'spread';
  readonly name: string;
}

interface InlineFragmentNode {
  readonly kind: 'inline';
  readonly typeCondition: string | null;
  readonly selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | SpreadNode | InlineFragmentNode;

interface OperationNode {
  readonly operation: 'query' | 'mutation';
  readonly name: string | null;
  readonly variableNames: string[];
  readonly selectionSet: SelectionNode[];
}

interface FragmentNode {
  readonly name: string;
  readonly typeCondition: string;
  readonly selectionSet: SelectionNode[];
}

interface DocumentNode {
  readonly operations: OperationNode[];
  readonly fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selectionSet = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selectionSet });
        continue;
      }
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variableNames: [], selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableNames = this.parseVariableDefinitions();
        this.skipDirectives();
        const selectionSet = this.parseSelectionSet();
        operations.push({ operation: operation === 'subscription' ? 'query' : operation, name, variableNames, selectionSet });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token.value)} at document level`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): string[] {
    const names: string[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        names.push(this.expectName());
        this.expectPunct(':');
        this.parseType();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          this.parseValue();
        }
        this.skipDirectives();
      }
      this.expectPunct(')');
    }
    return names;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------
// values and wrappers
// ---------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function valueFromAst(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return node.name in variables ? variables[node.name] : undefined;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueFromAst(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromAst(field.value, variables);
      return out;
    }
  }
}

interface Wrapper {
  readonly __typename: string;
  readonly [key: string]: unknown;
}

function wrap(typename: string, fields: Record<string, unknown>): Wrapper {
  return { __typename: typename, ...fields };
}

// ---------------------------------------------------------------------------
// schema: field resolvers per type
// ---------------------------------------------------------------------------

interface Ctx {
  readonly store: ForgeStore;
  readonly errors: Array<{ message: string }>;
  readonly fragments: Map<string, FragmentNode>;
  readonly variables: Variables;
}

type Resolver = (parent: Wrapper, args: Record<string, unknown>, ctx: Ctx) => unknown;

const SCHEMA: Record<string, Record<string, Resolver>> = {};

function issueStateValue(issue: IssueRecord): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateValue(pull: PullRecord): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueWrapper(store: ForgeStore, repo: RepoRecord, issue: IssueRecord): Wrapper {
  return wrap('Issue', { repo, issue, id: store.issueGlobalId(repo, issue) });
}

function pullWrapper(store: ForgeStore, repo: RepoRecord, pull: PullRecord): Wrapper {
  return wrap('PullRequest', { repo, pull, id: store.pullGlobalId(repo, pull) });
}

function repoWrapper(store: ForgeStore, repo: RepoRecord): Wrapper {
  return wrap('Repository', { repo, id: store.repoGlobalId(repo) });
}

function userWrapper(store: ForgeStore, login: string): Wrapper {
  return wrap('User', { login, id: login === store.viewer.login ? store.viewer.id : 0 });
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const number = Number(text.slice('cursor:'.length));
    return Number.isInteger(number) ? number : null;
  } catch {
    return null;
  }
}

function buildSchema(): void {
  SCHEMA.Query = {
    viewer: (_parent, _args, ctx) => userWrapper(ctx.store, ctx.store.viewer.login),
    repository: (_parent, args, ctx) => {
      const owner = args.owner as string;
      const name = args.name as string;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repoWrapper(ctx.store, repo) : null;
    },
    node: (_parent, args, ctx) => {
      const id = args.id as string;
      const repo = ctx.store.findRepoByGlobalId(id);
      if (repo) return repoWrapper(ctx.store, repo);
      const issueHit = ctx.store.findIssueByGlobalId(id);
      if (issueHit) return issueWrapper(ctx.store, issueHit.repo, issueHit.issue);
      const pullHit = ctx.store.findPullByGlobalId(id);
      if (pullHit) return pullWrapper(ctx.store, pullHit.repo, pullHit.pull);
      return null;
    },
    __type: (_parent, args, _ctx) => {
      const name = args.name as string;
      const type = TYPE_INFO[name];
      if (!type) return null;
      return wrap('__Type', { name, kind: type.kind, fieldNames: type.fields, enumNames: type.enumValues });
    },
  };

  SCHEMA.Mutation = {
    createIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = ctx.store.findRepoByGlobalId(String(input.repositoryId ?? ''));
      if (!repo) throw new FieldError('repository not found');
      const created = ctx.store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : null, []);
      if ('unknownLabel' in created) throw new FieldError('label does not exist');
      return wrap('CreateIssuePayload', { issue: issueWrapper(ctx.store, repo, created.issue) });
    },
    closeIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const hit = ctx.store.findIssueByGlobalId(String(input.issueId ?? ''));
      if (!hit) throw new FieldError('issue not found');
      hit.issue.state = 'closed';
      return wrap('CloseIssuePayload', { issue: issueWrapper(ctx.store, hit.repo, hit.issue) });
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = ctx.store.findRepoByGlobalId(String(input.repositoryId ?? ''));
      if (!repo) throw new FieldError('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = ctx.store.resolveRef(repo, head);
      const baseSha = ctx.store.resolveRef(repo, base);
      if (!headSha) throw new FieldError(`head branch does not exist: ${head}`);
      if (!baseSha) throw new FieldError(`base branch does not exist: ${base}`);
      const pull = ctx.store.createPull(
        repo,
        String(input.title ?? ''),
        typeof input.body === 'string' ? input.body : null,
        head,
        base,
        headSha,
        baseSha,
      );
      return wrap('CreatePullRequestPayload', { pullRequest: pullWrapper(ctx.store, repo, pull) });
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const hit = ctx.store.findPullByGlobalId(String(input.pullRequestId ?? ''));
      if (!hit) throw new FieldError('pull request not found');
      if (hit.pull.state !== 'open') throw new FieldError('pull request is not open');
      const sha = ctx.store.mergePull(hit.repo, hit.pull);
      if (sha === null) throw new FieldError('merge conflict');
      return wrap('MergePullRequestPayload', { pullRequest: pullWrapper(ctx.store, hit.repo, hit.pull) });
    },
    addComment: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const hit = ctx.store.findIssueByGlobalId(String(input.subjectId ?? ''));
      if (!hit) throw new FieldError('subject not found');
      const comment = ctx.store.addComment(hit.repo, hit.issue, String(input.body ?? ''));
      const node = wrap('IssueComment', {
        id: ctx.store.commentGlobalId(hit.repo, comment),
        body: comment.body,
      });
      return wrap('AddCommentPayload', { commentEdge: wrap('CommentEdge', { node }) });
    },
  };

  SCHEMA.User = {
    login: (parent) => parent.login as string,
    id: (parent, _args, ctx) => Buffer.from(`User:${(parent.id as number) || ctx.store.viewer.id}`, 'utf8').toString('base64'),
    name: (_parent, _args, ctx) => ctx.store.viewer.name,
    email: (_parent, _args, ctx) => ctx.store.viewer.email,
  };

  SCHEMA.Repository = {
    id: (parent) => parent.id as string,
    databaseId: (parent) => (parent.repo as RepoRecord).dbId,
    name: (parent) => (parent.repo as RepoRecord).name,
    nameWithOwner: (parent) => {
      const repo = parent.repo as RepoRecord;
      return `${repo.owner}/${repo.name}`;
    },
    owner: (parent, _args, ctx) => userWrapper(ctx.store, (parent.repo as RepoRecord).owner),
    defaultBranchRef: (parent) => wrap('Ref', { name: (parent.repo as RepoRecord).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (parent) => (parent.repo as RepoRecord).description,
    url: (parent) => {
      const repo = parent.repo as RepoRecord;
      return `https://github.com/${repo.owner}/${repo.name}`;
    },
    issue: (parent, args, ctx) => {
      const repo = parent.repo as RepoRecord;
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueWrapper(ctx.store, repo, issue) : null;
    },
    issues: (parent, args, ctx) => {
      const repo = parent.repo as RepoRecord;
      let list = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states);
        list = list.filter((issue) => wanted.has(issueStateValue(issue)));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = orderBy.direction === 'ASC' ? 1 : -1;
      const field = String(orderBy.field ?? 'CREATED_AT');
      if (field === 'CREATED_AT' || field === 'UPDATED_AT') {
        list.sort((a, b) => (direction === 1 ? a.number - b.number : b.number - a.number));
      } else {
        list.sort((a, b) => (direction === 1 ? a.number - b.number : b.number - a.number));
      }
      const afterNumber = decodeCursor(args.after);
      if (afterNumber !== null) {
        const index = list.findIndex((issue) => issue.number === afterNumber);
        list = index >= 0 ? list.slice(index + 1) : list.filter((issue) => (direction === 1 ? issue.number > afterNumber : issue.number < afterNumber));
      }
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
      const page = list.slice(0, first);
      const hasNextPage = list.length > page.length;
      const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as IssueRecord).number) : null;
      const startCursor = page.length > 0 ? encodeCursor((page[0] as IssueRecord).number) : null;
      return wrap('IssueConnection', {
        nodes: page.map((issue) => issueWrapper(ctx.store, repo, issue)),
        pageInfo: wrap('PageInfo', { hasNextPage, hasPreviousPage: afterNumber !== null, startCursor, endCursor }),
        totalCount: list.length,
      });
    },
    pullRequests: (parent, args, ctx) => {
      const repo = parent.repo as RepoRecord;
      const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
      const page = list.slice(0, first);
      return wrap('PullRequestConnection', {
        nodes: page.map((pull) => pullWrapper(ctx.store, repo, pull)),
        pageInfo: wrap('PageInfo', {
          hasNextPage: list.length > page.length,
          hasPreviousPage: false,
          startCursor: page.length ? encodeCursor((page[0] as PullRecord).number) : null,
          endCursor: page.length ? encodeCursor((page[page.length - 1] as PullRecord).number) : null,
        }),
        totalCount: list.length,
      });
    },
    pullRequest: (parent, args, ctx) => {
      const repo = parent.repo as RepoRecord;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullWrapper(ctx.store, repo, pull) : null;
    },
  };

  SCHEMA.Ref = {
    name: (parent) => parent.name as string,
  };

  SCHEMA.Issue = {
    id: (parent) => parent.id as string,
    number: (parent) => (parent.issue as IssueRecord).number,
    title: (parent) => (parent.issue as IssueRecord).title,
    state: (parent) => issueStateValue(parent.issue as IssueRecord),
    body: (parent) => (parent.issue as IssueRecord).body,
    url: (parent, _args, ctx) => {
      const repo = parent.repo as RepoRecord;
      const issue = parent.issue as IssueRecord;
      return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
    },
    createdAt: (_parent, _args, ctx) => ctx.store.nowIso(),
    updatedAt: (_parent, _args, ctx) => ctx.store.nowIso(),
    author: (parent, _args, ctx) => userWrapper(ctx.store, (parent.issue as IssueRecord).authorLogin),
    repository: (parent, _args, ctx) => repoWrapper(ctx.store, parent.repo as RepoRecord),
  };

  SCHEMA.IssueConnection = {
    nodes: (parent) => parent.nodes as Wrapper[],
    pageInfo: (parent) => parent.pageInfo as Wrapper,
    totalCount: (parent) => parent.totalCount as number,
  };

  SCHEMA.PageInfo = {
    hasNextPage: (parent) => parent.hasNextPage as boolean,
    hasPreviousPage: (parent) => parent.hasPreviousPage as boolean,
    startCursor: (parent) => parent.startCursor as string | null,
    endCursor: (parent) => parent.endCursor as string | null,
  };

  SCHEMA.PullRequest = {
    id: (parent) => parent.id as string,
    number: (parent) => (parent.pull as PullRecord).number,
    title: (parent) => (parent.pull as PullRecord).title,
    body: (parent) => (parent.pull as PullRecord).body,
    state: (parent) => pullStateValue(parent.pull as PullRecord),
    merged: (parent) => (parent.pull as PullRecord).merged,
    headRefName: (parent) => (parent.pull as PullRecord).headRef,
    baseRefName: (parent) => (parent.pull as PullRecord).baseRef,
    mergeable: (parent, _args, ctx) => ctx.store.pullMergeable(parent.repo as RepoRecord, parent.pull as PullRecord),
    url: (parent) => {
      const repo = parent.repo as RepoRecord;
      const pull = parent.pull as PullRecord;
      return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
    },
    createdAt: (_parent, _args, ctx) => ctx.store.nowIso(),
    updatedAt: (_parent, _args, ctx) => ctx.store.nowIso(),
    author: (parent, _args, ctx) => userWrapper(ctx.store, (parent.pull as PullRecord).authorLogin),
    files: (parent, args, ctx) => {
      const repo = parent.repo as RepoRecord;
      const pull = parent.pull as PullRecord;
      const changes = ctx.store.pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : changes.length;
      const page = changes.slice(0, first);
      return wrap('PullRequestChangedFileConnection', {
        nodes: page.map((change) =>
          wrap('PullRequestChangedFile', { path: change.path, additions: change.additions, deletions: change.deletions, changeType: change.status.toUpperCase() }),
        ),
        pageInfo: wrap('PageInfo', { hasNextPage: changes.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null }),
      });
    },
  };

  SCHEMA.PullRequestConnection = {
    nodes: (parent) => parent.nodes as Wrapper[],
    pageInfo: (parent) => parent.pageInfo as Wrapper,
    totalCount: (parent) => parent.totalCount as number,
  };

  SCHEMA.PullRequestChangedFileConnection = {
    nodes: (parent) => parent.nodes as Wrapper[],
    pageInfo: (parent) => parent.pageInfo as Wrapper,
  };

  SCHEMA.PullRequestChangedFile = {
    path: (parent) => parent.path as string,
    additions: (parent) => parent.additions as number,
    deletions: (parent) => parent.deletions as number,
    changeType: (parent) => parent.changeType as string,
  };

  SCHEMA.IssueComment = {
    id: (parent) => parent.id as string,
    body: (parent) => parent.body as string,
  };

  SCHEMA.CommentEdge = {
    node: (parent) => parent.node as Wrapper,
    cursor: () => null,
  };

  SCHEMA.CreateIssuePayload = { issue: (parent) => parent.issue as Wrapper };
  SCHEMA.CloseIssuePayload = { issue: (parent) => parent.issue as Wrapper };
  SCHEMA.CreatePullRequestPayload = { pullRequest: (parent) => parent.pullRequest as Wrapper };
  SCHEMA.MergePullRequestPayload = { pullRequest: (parent) => parent.pullRequest as Wrapper };
  SCHEMA.AddCommentPayload = { commentEdge: (parent) => parent.commentEdge as Wrapper };

  SCHEMA.__Type = {
    name: (parent) => parent.name as string,
    kind: (parent) => parent.kind as string,
    description: () => null,
    fields: (parent) => (parent.fieldNames as string[]).map((name) => wrap('__Field', { name })),
    enumValues: (parent) => (parent.enumNames as string[]).map((name) => wrap('__EnumValue', { name })),
  };
  SCHEMA.__Field = {
    name: (parent) => parent.name as string,
    description: () => null,
  };
  SCHEMA.__EnumValue = {
    name: (parent) => parent.name as string,
    description: () => null,
  };
}

class FieldError extends Error {}

// The introspection catalogue: every type the schema describes, with the
// fields and enum values gh's feature probes look for.
const TYPE_INFO: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node'], enumValues: [] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'], enumValues: [] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url'], enumValues: [] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url'],
    enumValues: [],
  },
  Ref: { kind: 'OBJECT', fields: ['name'], enumValues: [] },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'repository'], enumValues: [] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'], enumValues: [] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'], enumValues: [] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url', 'createdAt', 'updatedAt', 'author'],
    enumValues: [],
  },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'], enumValues: [] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'], enumValues: [] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body'], enumValues: [] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
};

buildSchema();

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

function executeSelectionSet(
  selections: SelectionNode[],
  parent: Wrapper,
  parentType: string,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = SCHEMA[parentType] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== parentType && fragment.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelectionSet(fragment.selectionSet, parent, parentType, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType && selection.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelectionSet(selection.selectionSet, parent, parentType, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = parentType;
      continue;
    }
    const resolver = fields[selection.name];
    if (!resolver) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = valueFromAst(arg.value, ctx.variables);
    let value: unknown;
    try {
      value = resolver(parent, args, ctx);
    } catch (error) {
      if (error instanceof FieldError) {
        ctx.errors.push({ message: error.message });
        out[key] = null;
        continue;
      }
      throw error;
    }
    out[key] = completeValue(value, selection.selectionSet, ctx);
  }
  return out;
}

function completeValue(value: unknown, selectionSet: SelectionNode[] | null, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selectionSet, ctx));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    const wrapper = value as Wrapper;
    if (selectionSet === null) return {};
    return executeSelectionSet(selectionSet, wrapper, wrapper.__typename, ctx);
  }
  return value;
}

export interface GraphQLResult {
  readonly data: unknown;
  readonly errors?: Array<{ message: string }>;
}

export function executeGraphQL(store: ForgeStore, query: string, variables: Variables, operationName?: string): GraphQLResult {
  let document: DocumentNode;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'syntax error' }] };
  }
  let operation: OperationNode | undefined;
  if (operationName !== undefined) {
    operation = document.operations.find((candidate) => candidate.name === operationName);
  }
  operation ??= document.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'no operation in document' }] };
  const ctx: Ctx = { store, errors: [], fragments: document.fragments, variables };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root = wrap(rootType, {});
  let data: Record<string, unknown>;
  try {
    data = executeSelectionSet(operation.selectionSet, root, rootType, ctx);
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'execution error' }] };
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}
