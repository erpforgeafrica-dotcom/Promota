# ORCHESTRATION.md — how the Promota agent layer runs

The runbook for `C:\Users\pc\owoworks\.opencode/`. It says which agent runs
when, how work escalates, what makes the orchestrator refuse to continue,
and which open-source patterns this is built on and where each one was
adapted.

Read `AGENTS.md` first: it holds the invariants. This file holds the
procedure.

---

## 1. The shape of the layer

```
owner  ->  promota-orchestrator  ->  specialists  ->  promota-release-gate  ->  owner
                  |                       |                    |
            plan, route,           implement and        two independent
            evidence gate          prove, per remit      passes must agree
```

Ten agents, five skills, three commands. The agents own *who* does a piece of
work and what they are allowed to touch. The skills own *how* a procedure
runs. The commands are what the owner types.

| Layer | Where | Contract |
|---|---|---|
| Agents | `.opencode/agent/*.md` | a remit, a model, a tool/permission boundary |
| Skills | `.opencode/skill/<name>/SKILL.md` | a procedure with commands and expected output |
| Commands | `.opencode/command/*.md` | an owner-facing entry point that wires an agent to a skill |

Nothing is duplicated across the three: an agent says "the money-path map is
in the `promota-money-flow` skill", the skill says "the reviewer is
`promota-money-path-auditor`", and the command says "load the skill, then
dispatch the agent".

### Directory naming, verified

opencode v1.18.35 documents the plural subdirectory names (`agents/`,
`commands/`, `skills/`) and keeps the singular forms for backwards
compatibility. This layer uses the singular forms — `.opencode/agent/`,
`.opencode/skill/`, `.opencode/command/` — and that was confirmed
empirically, not assumed: a probe project carrying the same file in both
`agent/` and `agents/` was loaded by `opencode agent list` and
`opencode debug config` from both, and `opencode debug skill` reported both
`.opencode/skill/<name>/SKILL.md` and `.opencode/skills/<name>/SKILL.md`.
The project config at `.opencode/opencode.json` was confirmed to be picked
up by the same probe.

### The instructions entry, and one honest caveat

`.opencode/opencode.json` sets `instructions` to the absolute path
`C:\Users\pc\owoworks\AGENTS.md`, which mirrors how the global config points
at `GLOBAL.md`. The resolved config confirms it is merged in alongside the
global entry.

opencode **also** auto-discovers `AGENTS.md` at the worktree root — a probe
directory with no project config at all still listed `AGENTS.md` and
`CONTRIBUTING.md` in its resolved instructions. So `AGENTS.md` is loaded
twice: once by the explicit absolute path and once by auto-discovery. The
content is identical and the cost is a duplicated block of instructions, not
a behavioural difference. The explicit entry is kept because the brief
requires it and because it guarantees the file is loaded regardless of the
working directory opencode was started from; if the owner prefers one copy,
deleting the `instructions` block from `.opencode/opencode.json` leaves
auto-discovery in place.


---

## 2. The goal-oriented expert-agent loop

One loop, repeated. The orchestrator never implements and never certifies.

```
 1. INTAKE      restate the goal in one line; ask ONE question if it is
                ambiguous
 2. DECOMPOSE   work items, one owner each, files named; items touching the
                same file are sequential
 3. ROUTE       pick the specialist (table below)
 4. IMPLEMENT   the specialist works; the orchestrator does not edit its
                files
 5. VERIFY      npm test / npm run site / checkImage, run by the
                orchestrator, counts recorded
 6. REVIEW      money-path-auditor and security-reviewer in parallel,
                both read-only
 7. GATE        release-gate: two independent passes must agree
 8. DOCUMENT    docs-keeper brings README/STATUS/CHANGELOG/audit true
 9. REPORT      what was done, the commands and their output, what was not
                done
```

The loop is goal-oriented: the goal is the unit of work, not the file. A
single-file change still passes through steps 5 and 7 — the evidence gate
and the release gate are what stop a "quick fix" from shipping untested.

---

## 3. When each agent runs

| Agent | Runs when | Mode | Model |
|---|---|---|---|
| `promota-orchestrator` | Always, for any multi-step work; it is the default entry point | primary | `google_gemini/gemini-3.6-flash` |
| `promota-backend-engineer` | `api/`, `providers/`, `server.mjs` routes, idempotency, outbox | subagent | `google_gemini/gemini-3.6-flash` |
| `promota-frontend-engineer` | `apps/web/**` — HTML, CSS, vanilla JS, CSP, accessibility | subagent | `google_gemini/gemini-3.6-flash` |
| `promota-db-engineer` | `db/migrations/*.sql`, RLS, grants, functions, triggers | subagent | `google_gemini/gemini-3.6-flash` |
| `promota-money-path-auditor` | **Before** any change to points, redemption, payout, escrow or the outbox; and on every release | subagent | `google_gemini/gemini-3.6-flash` |
| `promota-security-reviewer` | On every change touching RLS, grants, sessions, input validation, secrets; and on every release | subagent | `groq/openai/gpt-oss-120b` |
| `promota-test-engineer` | Whenever behaviour changes, and whenever a suite fails | subagent | `google_gemini/gemini-3.6-flash` |
| `promota-devops-engineer` | `Dockerfile`, `railway.json`, CI, `/healthz`, `/readyz`, deploys, env vars | subagent | `groq/openai/gpt-oss-120b` |
| `promota-release-gate` | Before every release; it is the only agent that may pass one | subagent | `groq/openai/gpt-oss-120b` |
| `promota-docs-keeper` | After the code is proven and before the report | subagent | `google_gemini/gemini-3.6-flash` |

### Model choice

Orchestration and implementation reasoning run on
`google_gemini/gemini-3.6-flash` (1M context, 64k output — it holds a whole
migration file and the diff that touches it in one window). The review roles
— security, release gate, devops — run on `groq/openai/gpt-oss-120b`,
because a review is a narrow, adversarial read of a bounded set of files and
that model is the stronger reviewer in this harness. The models are listed
once in `.opencode/opencode.json` and repeated in each agent's frontmatter
so a single file is self-describing; the two must be changed together.

### Order rules

- **Money path first.** A design touching `point_entries`, `redemptions`,
  `payout_accounts`, `campaign_payments`, the ledger or the outbox is
  reviewed by `promota-money-path-auditor` *before* code is written.
- **Database before API.** If a rule can live in SQL, it goes in
  `db/migrations/` and the API only moves arguments.
- **Test before claim.** New behaviour lands with a case in the repo's own
  harness.
- **Docs last.** A doc that describes intent is not evidence.

---

## 4. Escalation path

```
specialist  ->  orchestrator  ->  release-gate  ->  owner
  blocked        needs a          GO / NO-GO       identity,
                 decision         on the whole     money amounts,
                 or a second      change           provider accounts,
                 opinion                            legal calls,
                                                    plan changes
```

Rules for the escalation itself:

- An escalation carries the facts. "I need X, here is what I tried, here is
  the output" — not "I cannot proceed".
- The orchestrator resolves what an agent can resolve and escalates only
  what an agent must not decide: money amounts and plans, provider
  accounts, legal and regulatory calls, deployment identity, and anything
  that would need a secret written down.
- The release gate escalates upward, never sideways: it does not fix, and it
  does not argue with a reviewer. It records the disagreement and blocks.

---

## 5. Hard stop conditions

The orchestrator refuses to continue — and says why — when any of these is
true. They are not warnings; they are stops.

1. **An applied migration would have to be edited.** Applied migrations are
   recorded in `public.owoworks_schema_migrations`. The fix is a new
   forward file.
2. **A test would have to be weakened or deleted** to make the suite green.
   A failing test is a finding, not an obstacle.
3. **A security fix would weaken an RLS policy, a `revoke`, or a
   constraint.** The boundary is the product.
4. **The money path cannot be proven end to end** and the change would move
   points or naira.
5. **`npm test` fails after two honest attempts.** Report the failing case,
   its output, what was tried, and stop.
6. **The Railway account is not confirmed.** The owner must name it in this
   conversation **and** a live `railway whoami` must return that identity.
   `STATUS.md` records a past deployment account; that is history, not
   permission.
7. **A secret value would have to be printed, pasted or committed.** Cite the
   path and the variable name instead.
8. **A provider call would be made without a confirmation** to back the
   state it would write. Nothing is marked delivered that was not actually
   delivered.
9. **The live check would be skipped** and the work reported as shipped.
   HTTP 200 is not a proof; a deploy that was started and not verified is
   `UNKNOWN`.

---

## 6. The MCP set, and why each one is here

Configured in `.opencode/opencode.json`. Every server earns its place by a
task this repo actually has; no server was added that needs a secret the
repo cannot get.

| Server | Form | The task it serves |
|---|---|---|
| `filesystem` | local, scoped to `C:\Users\pc\owoworks` | reading and writing inside this repo only. Scoping it here means the global `filesystem` server (scoped to the global default project) cannot reach into Promota by accident |
| `context7` | remote, `https://mcp.context7.com/mcp` | current library docs when a Node 22, PostgREST or PGlite API is in question — the repo runs no framework, so the reference is the upstream doc |
| `playwright` | local, `npx -y @playwright/mcp@latest` | the live-UI verification in the `promota-ui-verify` skill: loading the deployed app, reading the accessibility snapshot, checking focus and roles |
| `railway` | local, `railway mcp` | the deploy surface this repo uses — service, variables, logs, status |
| `github` | local, `npx -y @modelcontextprotocol/server-github` | the GitHub remote, the Actions workflow in `.github/workflows/test.yml`, and the review of what was pushed |

### Two notes on the configuration

**The `filesystem` scope is a deliberate trade.** While working in this
project, the `filesystem` MCP is scoped to `C:\Users\pc\owoworks` instead of
the global default project. Promota's files — including a gitignored `.env`
holding real provider credentials — stay inside that boundary.

**The GitHub token reaches the server through the environment.** The
`github` server is a local stdio process, and opencode's local MCP options
are `type`, `command`, `cwd`, `environment`, `enabled` and `timeout` — there
is no `headers` field for a local server. The brief's
`Authorization: Bearer {env:GITHUB_TOKEN}` is therefore expressed the way a
stdio server can consume it: `GITHUB_PERSONAL_ACCESS_TOKEN` and
`GITHUB_TOKEN` are both set from `{env:GITHUB_TOKEN}` in the server's
`environment` block, which is where the bearer token is read from.

`GITHUB_TOKEN` is **not** currently exported in this environment. A valid
token exists in the `gh` CLI's keyring (`gh auth status` shows
`erpforgeafrica-dotcom`), so before using the GitHub MCP tools, export one:

```powershell
$env:GITHUB_TOKEN = (gh auth token)
```

Without it the server starts but every call is unauthorised, which is worse
than not having it. The other four servers need nothing beyond what this
machine already has: `node.exe` and the filesystem server exist on disk, the
`railway` CLI is installed, `context7` needs no key, and `playwright`
downloads itself through `npx`.

---

## 7. The open-source patterns this is based on

Each entry says what the pattern contributes and where it was adapted for a
repo where money is real and a false "it works" is the worst possible
outcome.

### SWE-agent / mini-swe-agent
<https://github.com/SWE-agent/mini-swe-agent>

**Contributes:** the minimal shell-driven loop — a model that runs commands,
reads the output, and edits files, with nothing between the model and the
terminal. Its discipline is that the loop is driven by *observed output*,
not by the model's confidence.

**Adapted here:** the orchestrator never edits the code itself; it runs the
gates and reads their output. The evidence gate in `AGENTS.md` ("a claim
cites a command that was run and its output") is mini-swe-agent's
command-as-evidence idea, tightened into a release blocker. The harness
itself is deliberately the repo's own, not a framework — this repo has no
framework dependency and does not want one.

### langchain-ai/open-swe
<https://github.com/langchain-ai/open-swe>

**Contributes:** the plan → implement → validate → PR sequence, with
parallel subagents for independent work and a single owner for the final
merge.

**Adapted here:** the orchestrator's decomposition step names one owner per
work item and forbids two agents on the same file. The "validate" stage is
split into a verification pass (the orchestrator runs the gates) and a
review pass (read-only specialists), which open-swe does not separate — the
separation matters here because the money-path reviewer must not be able to
edit the code it is reviewing.

### agentic-swe/agentic-swe
<https://github.com/agentic-swe/agentic-swe>

**Contributes:** bounded, named roles (developer, git operations, PR
manager) instead of one generalist, plus a parallel design panel and a
catalogue of subagents to pick from.

**Adapted here:** the ten agents are the catalogue, and each one carries a
remit narrow enough to be checkable — "the frontend engineer owns
`apps/web/`" is a boundary, "the backend engineer helps" is not. The
`promota-db-engineer` and `promota-backend-engineer` split mirrors the
role-boundary idea: SQL changes and JS changes have different reviewers,
different permissions and different tests.

### swe-copilot-agents
<https://pypi.org/project/swe-copilot-agents/>

**Contributes:** the coordinator/worker arrangement that puts the right
agent in front of the right problem at the right time, and keeps the
coordination logic out of the workers.

**Adapted here:** this is the direct model for `promota-orchestrator` plus
nine specialists. The "right time" part became the routing table in
`AGENTS.md` and the order rules in section 3 — the money-path reviewer runs
before the code is written, not after it is written and found wanting.

### OpenHands
<https://github.com/All-Hands-AI/OpenHands>

**Contributes:** the most-starred open coding agent; the model of an agent
that actually executes in a sandboxed environment, so its claims are
executable rather than narrated.

**Adapted here:** Promota has no sandbox to run in — the work happens on the
real repo against a real database and a real deployment. That removes
OpenHands' main safety net, so the compensation here is the permission
boundary: the auditors and the release gate have `edit` denied, the
orchestrator can only launch this project's own agents, `git push` and
`railway` require confirmation, and the release procedure is a documented
sequence with a Railway identity gate rather than an ad-hoc command.

### The DevOps/SRE agent and MCP set

- **kagent** — <https://github.com/kagent-dev/kagent>: an agent platform
  that binds each agent to a declared set of tools instead of letting it
  reach everything. *Adapted here:* the per-agent `permission` blocks. Each
  Promota agent is bound to a tool and path scope — auditors cannot write,
  the orchestrator cannot push without asking, and no agent may reach
  outside the project.
- **HolmesGPT** — <https://github.com/HolmesGPT/holmesgpt>: an SRE agent
  that investigates live systems from real signals. *Adapted here:* the
  live-check discipline in `promota-ui-verify` — the readiness probe, the
  runtime config read from the deployed container, and a real feature path
  rather than a liveness ping.
- **Grafana MCP** — <https://github.com/grafana/mcp-grafana>: metrics and
  dashboards as the evidence for an operational claim. *Adapted here:* the
  same idea without a Grafana instance. The evidence surface is the repo's
  own: `npm test` counts, `/readyz` checks, `scripts/verifyLive.mjs`, and
  the `PROOF/` bundles.
- **Terraform MCP Server** — <https://github.com/hashicorp/terraform-mcp-server>:
  infrastructure as code with destructive operations off by default
  (`enableTfOperations` defaults to false). *Adapted here:* the same default
  for state-changing operations — `railway` commands require confirmation
  and the Railway identity gate, and the release gate has `edit` denied so
  it cannot fix what it finds.
- **containers/kubernetes-mcp-server** — <https://github.com/containers/kubernetes-mcp-server>:
  a native, dependency-free server that acts on the real cluster rather
  than shelling out to `kubectl`. *Adapted here:* the `railway` MCP server
  and the local `playwright` and `github` servers — direct access to the
  deploy surface and the browser, instead of a shell wrapper that loses
  structure.

### The most-starred MCP servers

**filesystem**, **context7**, **playwright** and **github** are the most
used MCP servers in the ecosystem, and this repo needs all four for real
work: reading and writing inside the project, current upstream library docs
for a repo that runs no framework, a real browser for the live-UI check,
and the GitHub surface for the remote and the Actions workflow. Each is
configured with the minimum needed — one of them (`filesystem`) is scoped
down rather than up.

---

## 8. Two independent passes

`promota-release-gate` runs two passes that do not see each other's
conclusion:

- **Pass A** — the specialist reviews (money path, security, tests, devops).
- **Pass B** — the gate's own fresh verification: it re-runs the gates
  itself and records the exit codes and counts.

A release passes only when both agree. A disagreement is a NO-GO, and it is
reported as a disagreement rather than averaged away — a green suite and a
real defect are not contradictions when the suite does not cover the defect,
and saying so is more useful than forcing a consensus.

---

## 9. Keeping this layer honest

The layer itself is code in the repo, and it can go stale exactly like the
docs it governs. Two rules apply to it:

- If a specialist's remit changes, the agent file changes with it. An agent
  whose remit no longer matches the repo is worse than no agent.
- The `filesystem` MCP is scoped to this repo, the GitHub MCP needs an
  exported token, and the models are listed in two places (the config and
  each frontmatter). Both duplications are deliberate and both are noted in
  the files that carry them — change them together.
