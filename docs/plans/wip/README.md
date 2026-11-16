# Work in progress that is not part of the build

`c2a-partial.patch` is the unfinished work of task **C2a** (the pure double-proof rule of
`docs/plans/c2-double-proof-design.md`), saved on 15 Nov 2026 when the agent writing it hit the
account's usage limit. It is **not reviewed, not complete and does not compile with the rest** of the
tree. Nothing here runs: it sits in `docs/` so CI and the build ignore it.

What it holds (about 1,900 lines): `packages/core/src/payoutproof.ts` (`decideDoubleProof`, 581 lines),
`packages/core/src/payoutproof.test.ts` (965 lines), `packages/core/src/receiptaccount.ts` (the masked
account matcher moved into core), and edits to `packages/core/src/payoutflow.ts` (`auto_settle`),
`packages/core/src/index.ts` and `packages/payments/src/receipts/accountmatch.ts`.

Known to be unfinished: widening `ManualPayoutDenial` in `payoutflow.ts` leaves
`packages/db/src/payments/manualpayouts.ts` (the `claimDenial` text map, line 78) without a text for
the new reasons, so `pnpm typecheck` fails; its tests were never run; the "C2a built" section the design
asked for was not written.

To continue (Opus, high):

```bash
git apply --check docs/plans/wip/c2a-partial.patch && git apply docs/plans/wip/c2a-partial.patch
pnpm typecheck        # fix what it says, then run packages/core and packages/payments tests
```

Review it against the design's section 3 (decision table) and section 8 (tests) before trusting any
line of it. Delete this folder in the commit that lands C2a.
