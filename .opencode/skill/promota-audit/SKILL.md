---
name: promota-audit
description: "The house audit format for Promota: a findings table with ID, severity, evidence and an OBSERVED/TESTED/INFERRED/UNKNOWN label, the fixes applied this session, fresh evidence, a GO/NO-GO release posture, and a not-done section that records limitations instead of hiding them. Use when writing or rewriting audit/SPRINT22-CURRENT-REVIEW.md."
metadata:
  project: promota
---

The format of `audit/SPRINT22-CURRENT-REVIEW.md`. That file has been rewritten
across many sprints and its stable shape is what makes it readable, so the
structure below is not a suggestion — follow it exactly.

## Before you write

An audit is a fresh review, not a summary of the last one. It is produced
from the current tree:

1. Read the current source. `api/`, `providers/`, `db/migrations/`,
   `apps/web/`, `scripts/`, `Dockerfile`, `railway.json`,
   `.github/workflows/`.
2. Run the checks. A finding with no command behind it is `OBSERVED` at
   best.
3. Read the previous audit to collect the still-open items, then say what
   closed and what did not.
4. Get the identity facts live and read-only: the remote, the branch, HEAD,
   and the deployed state. Do not copy them from the previous audit.

## The labels

Every claim carries exactly one. There is no sixth label.

| Label | Means |
|---|---|
| `OBSERVED` | Read directly in the source at a named file and line. The code says this. |
| `TESTED` | A command was run and its output proves it. Cite the command. |
| `INFERRED` | Reasoned from the source but not executed. Say what would confirm it. |
| `UNKNOWN` | Cannot be settled from here. Say where it could be settled. |

The house rule from the previous audit: "README claims, mockups, schema,
proof bundles and other agents' reports are **not** proof of deployed
functionality. Absence of a feature is `NOT IMPLEMENTED`, never a simulated
pass." A green local suite does not prove the deployed service; a deployed
service returning 200 does not prove the feature works.

## The file structure

```markdown
# Promota — Current Review (HEAD <short-sha>)

**Date:** <YYYY-MM-DD> · **Repo:** `C:\Users\pc\owoworks` · **Branch:** `<branch>`
**HEAD:** `<full-sha>`
**Remote:** `<owner>/<repo>`

This supersedes the prior audit written at `<short-sha>`. Method: <what you
actually did — read-only source inspection, fresh test/smoke runs, a
Docker-image boot simulation, live probes>. Labels: OBSERVED / TESTED /
INFERRED / UNKNOWN.

## What changed since the prior audit (closed items)

| Prior finding | Status now |
|---|---|
| <the finding as it was worded> | `CLOSED` — <the evidence that closed it> |
| <finding> | `ADDRESSED` — <what moved it> |
| <finding> | `PARTIAL` — <what remains> |
| <finding> | `STILL OPEN` — <why> |

## Findings (this review)

| ID | Sev | Finding | Evidence | Label |
|---|---|---|---|---|
| P-001 | CRITICAL | <the defect, stated in one sentence, including the consequence> | `<file>:<line>` vs `<file>:<line>`; reproduced in <how> | TESTED |
| P-002 | HIGH | <finding> | <evidence> | OBSERVED→FIXED |
| P-003 | MEDIUM | <finding> | <evidence> | OBSERVED |
| P-004 | LOW | <finding> | <evidence> | INFERRED |

## Fixes applied this session

1. `<file>` — <what changed and why>.
2. `<file>` — <what changed and why>.
3. `<file>` — <new regression test and the defect it now prevents>.

## Fresh evidence

| Command | Result |
|---|---|
| `npm test` | EXIT 0 — phone 17/0, lead 24/0, API 48/0, image 7/0, ledger 56/0, leads 41/0, points 56/0, dataManager <n>/<n> |
| `node api/server.smoke.mjs` | PASS <n> / FAIL <n> — <what it proved> |
| `node scripts/checkImage.mjs` | EXIT 0 — IMAGE CONTENTS: ALL HOLD |
| `node db/live.proof.mjs` | PASS 14 / FAIL 0 / UNVERIFIED 0 — <what it proved> |
| image-sim boot | `ERR_MODULE_NOT_FOUND ...` (EXIT 1) — reproduced P-001 |

## Release posture

- **<surface>:** GO on the tested local artifact. <what must still happen
  before it is live, by name.>
- **<surface>:** NO-GO — <the specific blockers, named, not "needs work">.

## Not done (limitations recorded, not hidden)

- <what was not done, and why — provider quota, a missing credential, an
  account the owner did not name, a suite that needs live env.>
- <anything that was attempted and could not be completed.>
```

## Rules for each part

**Header.** The date is the date the checks ran. The branch, HEAD and remote
come from live read-only commands, not from the previous audit. The method
line states what you actually did — if you did not run a Docker boot
simulation, do not claim one.

**Closed items.** Every open item in the prior audit appears here, with a
status. `CLOSED` means there is evidence. `STILL OPEN` is a legitimate and
important status; use it.

**Findings.** One row per defect. The finding text states the defect *and
its consequence* — a reader who only reads the table must understand the
risk. The evidence column cites a file and line, or a command and its
result. The label is the last word in the row. Use the house severities:

| Sev | Meaning |
|---|---|
| CRITICAL | The deployed system breaks, or money/points can move wrongly. The release is blocked. |
| HIGH | A real defect on a reachable path; the system misbehaves for real users. |
| MEDIUM | A real defect with a narrower trigger, or a correctness gap that needs manual work. |
| LOW | A hardening gap, an honest-but-undocumented limitation, a hygiene item. |

A fixed finding keeps its ID and reads `OBSERVED→FIXED`. That is how a reader
sees that the audit's own defects were repaired.

**Fixes applied this session.** Only things actually changed in this session,
numbered, each naming the file. A fix with no test is incomplete — say so in
the audit.

**Fresh evidence.** The commands that were run in this session, with their
actual results. The counts are what the run printed. A command that was not
run is not in this table; if it matters, it goes in "Not done" instead.

**Release posture.** Per surface, not one verdict for the whole product. The
repo has shipped different surfaces at different times: lead capture has
been proven live; the data and cash redemption paths have not. Use `GO` with
the condition attached, or `NO-GO` with the blockers named. Never "ship with
caveats".

**Not done.** The most valuable section in the file. Everything you could not
complete, with the reason and what would complete it. The previous audit
recorded there that the purpose-built audit subagents could not run because a
provider quota was exhausted, and that a Railway deploy was not performed
because the account-freeze rule requires the owner to name the account
in-session. That is the standard: record the limitation, never hide it.

## Where the file lives

`audit/SPRINT22-CURRENT-REVIEW.md` is the current review. The sibling files
(`red-team-findings.md`, `business-model-audit.md`,
`release-gate-recommendation.md`, `evidence-integrity-review.md`,
`team-d-verification.md`, and the `*.csv` matrices) are the archive of
specific reviews. Do not fold them in and do not delete them.

## Related

- `.opencode/agent/promota-money-path-auditor.md` — the money-path findings
- `.opencode/agent/promota-security-reviewer.md` — the privilege findings
- `.opencode/agent/promota-release-gate.md` — the checklist this file
  summarises
- `.opencode/agent/promota-docs-keeper.md` — who writes this file
