---
description: Run a fresh audit of the Promota repo and rewrite audit/SPRINT22-CURRENT-REVIEW.md in the house format
agent: promota-orchestrator
subtask: false
---

Run a fresh audit of the Promota repo and rewrite
`audit/SPRINT22-CURRENT-REVIEW.md`.

Scope of this run: $ARGUMENTS

Act as the **Promota orchestrator**. An audit is a fresh review of the
current tree, not a summary of the last one.

1. **Load the skill.** `promota-audit` — it carries the exact file structure,
   the labels (OBSERVED / TESTED / INFERRED / UNKNOWN), the severities and
   the posture format. Follow it exactly; do not improvise a new structure.
2. **Establish the facts read-only.** The branch, HEAD and the remote, from
   live read-only commands. The previous audit's identity block is a record
   of a past event, not a source of truth.
3. **Read the current source.** `api/`, `providers/`, `db/migrations/`,
   `apps/web/`, `scripts/`, `Dockerfile`, `railway.json`,
   `.github/workflows/`.
4. **Run the checks, and record the actual output.** At minimum:
   ```powershell
   npm test
   npm run site
   node scripts/checkImage.mjs
   node scripts/predeploy-check.js
   ```
   Plus, when the money path or RLS is in scope:
   ```powershell
   node db/points.test.mjs
   node db/redemption-integrity.test.mjs
   node db/ledger.test.mjs
   node providers/dataManager.test.mjs
   node db/live.proof.mjs
   ```
   A command you did not run is not in the evidence table. If it matters and
   you could not run it, it goes in "Not done".
5. **Dispatch the two read-only reviewers in parallel** and attach their
   findings:
   - `promota-money-path-auditor` — false-success and points-mint paths;
   - `promota-security-reviewer` — RLS, privileges, filter injection, secret
     hygiene.
   Both are read-only and both report in the house format. `promota-test-engineer`
   and `promota-devops-engineer` cover the harness and the image/deploy
   contract if those areas changed.
6. **Collect the still-open items** from the previous audit and give each
   one a status: `CLOSED` with evidence, `ADDRESSED`, `PARTIAL`, or
   `STILL OPEN`. `STILL OPEN` is a legitimate and valuable status.
7. **Write the file.** `promota-docs-keeper` writes it, or you write it
   yourself following the skill — but the structure is not yours to change.
   Keep the sibling files in `audit/` as the archive of specific reviews;
   do not fold them in and do not delete them.
8. **Report.** The findings by severity, the posture per surface, and what
   was not done. Never report an audit as clean if it was not run.
