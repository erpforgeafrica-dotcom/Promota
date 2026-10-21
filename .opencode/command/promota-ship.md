---
description: Ship a Promota change end to end - verify, gate, commit, push, deploy to Railway, prove the live feature path, and document it
agent: promota-orchestrator
subtask: false
---

Ship the Promota change described by: $ARGUMENTS

Act as the **Promota orchestrator** and run the release procedure in
`.opencode/skill/promota-release/SKILL.md` end to end. Do not shortcut it.

The sequence:

1. **Intake.** State in one line what is being shipped. If `$ARGUMENTS` is
   empty or ambiguous, ask ONE clarifying question before doing anything.
2. **Load the skill.** `promota-release`. If the change touches points,
   redemption or payout, also load `promota-money-flow` and make sure
   `promota-money-path-auditor` reviews the diff before you deploy.
3. **Verify locally.** `npm test`, `npm run site`,
   `node scripts/checkImage.mjs`, `node scripts/predeploy-check.js`. Record
   the per-suite counts and the exit codes. A non-zero exit stops the
   release.
4. **Gate.** Hand the change to `promota-release-gate`. Both of its passes
   must agree. A NO-GO returns to the specialist that owns the finding; do
   not soften it.
5. **Migrate, if needed.** Forward-only, applied before the code ships, and
   confirmed with `npm run db:remote`, `npm run db:probe` and the running
   instance's `/readyz`. Never edit an applied migration.
6. **Commit and push.** Stage only this change, review the staged diff,
   write a commit message in the repo's style, push to the branch the
   deploy watches. No force-push, no `--hard`, no secrets.
7. **Railway identity gate.** The owner must name the account in this
   conversation, and a live `railway whoami` must confirm it. If either is
   missing, ask and stop. Never infer the account.
8. **Deploy and watch.** `railway up`, `railway logs --deployment`, then
   `/healthz` (frozen shape) and `/readyz` (all three checks ok).
9. **Live feature check.** Load `promota-ui-verify` and prove the real path
   against the deployed URL. HTTP 200 is not a proof. The rule from the
   skill applies here too: nothing is marked delivered that was not
   actually delivered.
10. **Document.** `promota-docs-keeper` updates `CHANGELOG.md`,
    `STATUS.md`, `README.md` where the wired surface changed, and appends
    the raw live output to `PROOF/`. The audit file is rewritten only via
    the `promota-audit` skill.
11. **Report.** What shipped, the commands run and their actual output, the
    live check result, the gate's checklist and posture, and what was NOT
    done and why.

Stop and escalate instead of continuing if a gate fails, if a migration
would have to be edited, if a test would have to be weakened, if the money
path cannot be proven, or if the Railway account is not confirmed.
