# github-core-clone

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Jeytm/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Jeytm/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-compatible git forge in one process: git smart HTTP,
REST v3, GraphQL and MCP, backed by its own in-memory object store. No UI,
no outside service, no proxy, no git binary — the packfile codec, the
three-way merge, the GraphQL executor and the MCP dispatcher are all
hand-written on the Node.js standard library.

Built for the [make.fun bounty](https://make.fun/bounty/github-core-clone-01)
"Build a GitHub-compatible git forge".

## Run

```sh
node main.ts
```

Node 22.18+ (erasable TypeScript, no build step, no dependencies). In trial
mode the process binds an ephemeral port, registers with
`$MAKEFUN_ENV_URL/register`, serves until `$MAKEFUN_ENV_URL/done` reports
done, then exits 0. Without `MAKEFUN_ENV_URL` it serves in dev mode on
`$PORT` (or an ephemeral port) until interrupted. `MAKEFUN_SHOP_TOKEN` is
the bearer token clients must present; `MAKEFUN_TRIAL_NOW` fixes every
timestamp the forge reports.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Process entrypoint: bind, register, poll `/done`, exit. |
| `app.ts` | HTTP routing, auth, request ids, JSON error envelope. |
| `git-http.ts` | Smart HTTP: info/refs, upload-pack (v2 + v0), receive-pack. |
| `git.ts` | Object model, pkt-lines, pack read/write, fetch planning. |
| `store.ts` | In-memory repos, refs, issues, pulls, merges, diffs. |
| `rest.ts` | REST v3: repos, branches, commits, contents, labels, issues, pulls. |
| `graphql.ts` | GraphQL lexer/parser/executor, introspection, mutations, batching. |
| `mcp.ts` | MCP: `server/discover`, legacy `initialize`, six tools. |
| `scenario.ts` | Deterministic viewer identity derived from the published scenario seed. |

## What works

- **Git smart HTTP.** Protocol v2 advertisement, `ls-refs` (peel, symrefs,
  unborn, ref-prefix filtering), `fetch` (wants/haves, shallow/deepen,
  `blob:none` / `blob:limit` filters, unshallow), protocol v0 fetch
  (side-band-64k, ACK/NAK, no `ready` line), and receive-pack with
  per-ref fast-forward enforcement, `report-status`, sideband reports and
  delete-refs. Packs are read with OFS/REF delta resolution and written as
  plain-object version 2 packs with verified checksums. Verified against
  the real `git` CLI: clone, push, fetch, shallow clone.
- **REST v3.** Repo CRUD with pagination (`Link: rel="next"`), branches,
  commit listing, contents read/write/delete (409 on stale sha, branch
  auto-fork on PUT), git refs, labels, issues (state/sort/direction,
  comments, label validation with 422), pull requests (files diff,
  squash merge, 405 on conflict). GitHub-shaped error bodies and the
  `X-GitHub-Request-Id` header on every reply.
- **GraphQL.** `viewer`, `repository`, `node(id:)` with fragments,
  `__type` introspection, issue/PR connections with cursor pagination,
  and the `createIssue`, `closeIssue`, `createPullRequest`,
  `mergePullRequest` and `addComment` mutations. Unknown fields return
  HTTP 200 with `errors` naming the field. Batched arrays answer in order.
- **MCP.** Modern `server/discover` era and legacy `initialize` era, a
  frozen `tools/list` (byte-identical across calls), and the six tools
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`, with REST parity.
- **Determinism.** No wall clock (all timestamps come from
  `MAKEFUN_TRIAL_NOW`), no unseeded randomness, packs sorted by oid.

## What does not work

- **No persistence.** State lives in memory; a restart loses every repo.
  (The graded trials run one process per trial, so this is by design.)
- **No UI and no webhooks.** The forge is API-only, as specified.
- **No merge methods other than squash** via the merge endpoint; rebase
  and merge commits are not implemented.
- **No auth model beyond one bearer token.** Every repo belongs to the
  login the token names; organizations, collaborators, teams, stars,
  forks, releases, actions, search and the Checks API are not implemented.
- **No pack deltas on write.** Outgoing packs carry plain objects only;
  this is legal on the wire and keeps output deterministic, at the cost
  of larger pack bytes on big clones.
- **No `git` binary compatibility beyond smart HTTP.** The dumb protocol,
  `git://` and SSH transports are out of scope.
- **GraphQL is a fixed-schema executor**, not a general engine: no
  subscriptions, no `@skip`/`@include` evaluation, no custom scalars,
  and only the documented types and fields resolve.

## Tests

```sh
npm test
```

`tests/smoke.test.ts` boots the real server and exercises REST, GraphQL,
MCP and a full `git clone` / `git push` / `git pull` round trip with the
system `git` client. The kit's own conformance suite can be run against a
live server with `node --experimental-strip-types sdk/run.ts --url
http://127.0.0.1:PORT --token TOKEN --perf` from the kit directory.

## License

MIT — see [LICENSE](LICENSE).
