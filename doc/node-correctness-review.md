# Node correctness review, 2026-10-20

The initial review used `f57e5edf2c35ba925f31af49b0fed6c1b4e58dab`. The bugs
below predate the three optimizations in that commit. The first three findings
are fixed together in the focused patch, with the verification recorded below;
the other findings remain outside this patch. Performance follow-ups are recorded
in [optimization future work](optimization-future-work.md).

## Network compatibility requirement

User requirement, confirmed 2026-10-20: this node must remain compatible with the
other nodes on the existing network. A local patch must preserve block/header
acceptance, deterministic ledger results, cumulative work and fork choice,
historical activation rules, and existing P2P encodings. Fixing an apparent bug
does not authorize changing those rules.

**IMPOSSIBLE CURRENTLY** means excluded from implementation and deployment under
this requirement. It is not waiting for routine local approval. Reconsidering
such a change would require a separately agreed network upgrade and activation
plan. No such upgrade is part of this work.

| Proposed fix | Compatibility status | Permitted scope |
| --- | --- | --- |
| Prune expired transactions after a reorg | Eligible as a local fix | Change only mempool eligibility and template selection. Keep received-block pin/nonce decoding, validity windows, signatures and confirmed transaction-ID replay protection unchanged. |
| Preserve successful-prefix balance updates | Eligible as a local fix | Reconcile the mempool with balances already committed by the existing block applier. Preserve the valid prefix, rejection height, database/undo results and fork-choice decision. |
| Remove confirmed reservations before balance reconciliation | Eligible as a local fix | Change pending-transaction accounting and selection only. Preserve confirmed balances, block validity and fee/reward rules. |
| Repair failed-address insertion | Eligible as a local fix | Maintain the local sorted set using the existing addresses, connection rules and P2P protocol. |
| Return after invalid Janushash input | Eligible as a local fix | Preserve valid-input output and hashing. Stop after the existing invalid-input response; do not change Janushash/PoW calculations or accepted header versions. |
| Correct hashrate reporting | Conditional: reporting only | Correct the estimate/chart without changing consensus work values or fork choice. Prefer a reporting-specific range calculation. Any shared `sum_work` edit must prove identical genesis-prefix work and header acceptance at all historical activation boundaries; a change to those results is **IMPOSSIBLE CURRENTLY**. |
| Synchronize chain-worker flags | Eligible as a local fix | Repair locking and wakeups while preserving event order, shutdown ownership and transaction boundaries. |
| Repair/remove the unused header-prefix constructor | Conditional: exact snapshot equivalence | Return the same header prefix, verifier state and cumulative work as the existing chain. Do not change chain validation, work formulas or historical behavior to accommodate the repair. |
| Correct `TimestampValidator::tmax` and enforce the intended drop limit | **IMPOSSIBLE CURRENTLY — consensus change** | The current validator can accept timestamps that the corrected validator would reject. Leave its acceptance behavior unchanged; keep this finding outside the eligible fix queue. |

Eligible/conditional describes the allowed design, not a completed compatibility
qualification. Local mempool contents and the choice among valid transactions
may differ between nodes; every received and mined block must still satisfy the
existing network rules. Synthetic reproductions do not prove mixed-node or
historical consensus equivalence. The full optimization inventory is classified
in [the future-work compatibility review](optimization-future-work.md#network-compatibility-review).

## Focused reconciliation patch

Implemented and validated on 2026-10-20. Runtime edits
are limited to `chainserver/state/helpers/consensus.cpp` and
`chainserver/state/transactions/apply_stage.cpp`.

- Fork reconciliation removes invalidated, expired and newly confirmed pending
  transactions before applying final balances. Restored transactions are skipped
  when already confirmed or below the existing local admission pin threshold.
- Both append paths remove confirmed reservations before applying final balances.
  True unaffordable pending spends still follow the existing fee-based eviction
  policy. The existing single-append boundary policy is retained.
- A partially failed stage returns the successful prefix's balance updates along
  with its confirmed transaction IDs. If that prefix wins, its already-written
  balances reach the mempool; if it does not win, the existing transaction rolls
  back without modifying the mempool.

The confirmed-ID merge/prune rules, ledger writes, rejection rules, fork-choice
calculation, timestamps, hashing and wire encodings remain unchanged. The moved
confirmed-ID reconciliation in a fork produces the same final replay-protection
set; it releases reservations sooner. No other optimization or bug fix is included.

### Verification

The new [native regression](../src/test/mempool_reconciliation.cpp) has five
groups: single append, multi append, fork expiry, fork balances and partial stage.
All five failed against the unchanged baseline at the expected assertions and
pass with this patch. Checks include:

- Longer, equal-length and shorter replacement chains, pin-window boundaries,
  expired live/restored transactions and newly confirmed rollback transactions.
- Affordable pending transactions, genuine balance-driven eviction and exact
  remaining reservations after restoration and further admission.
- Master/follower ID/hash indexes, fee order, update logs and identical mining
  bodies, followed by real body/signature validation of selected templates.
- Twelve partial-stage cases across DELETE and WAL, covering balance, signature
  and duplicate-ID failures after valid prefixes, a winning fork prefix, a
  nonwinning fork and failure before any valid block. Rejection codes/heights
  and fork-choice outcomes are checked. Canonical ledger, history, undo and work
  match independent valid-prefix controls, or the original state after rollback.

All **15 native suites** passed, including the existing SQLite fault tests.
The separate offline checks passed 100 genuine mainnet block replays, two
peer-policy handshake/ping/rejection checks, 100 valid local HTTP block
submissions with receiving peers, 40 SIGKILL cases and 28 chain/state/history
recovery cases. The replay's logical digest remains
`c65ed07288a474ea710db808d65f4fb7660e6533a312f350fae29fe68ed6fe41`, and its
P2P transcript matches the pre-patch release exactly.

The native fixtures use synthetic funded databases and unmined testnet headers;
they do not bypass any checks in production code. The genuine replay is limited
to the committed historical fixture and is not a current-height mixed-fleet test.
There is no claim of improved mining revenue, live latency or physical power-cut
recovery. Release optimization retains assertions. Evidence, baseline/candidate
binaries and source hashes are saved locally under the ignored
`build/mempool-reconciliation-20261020/` directory; 243 compiled runtime sources
and the new compiled test source were checked against the working tree.

## Findings and original fix priorities

The first three rows below are implemented by the focused patch above. The
remaining rows are still proposals, subject to their compatibility classifications.

| Priority | Finding | Evidence and consequence | Suggested patch and regression coverage |
| --- | --- | --- | --- |
| 1 | Expired transactions survive a longer reorg | `Chainstate::fork` removes transactions pinned beyond the fork, but never prunes the new chain's expired lower pin range. A signed transaction pinned at zero survived a synthetic fork from height 8,190 to 8,256, was selected for mining, and caused `generate_body` to throw `Cannot make pin_nonce`. | Reconcile both ends of the pin window after a fork, including restored transactions. Cover longer and shorter forks, boundary heights, included transactions, master/follower logs, and successful subsequent template generation. |
| 1 | A partially successful stage loses balance updates | The error return from `apply_stage_blocks` transfers transaction IDs, but omits `ba.move_balance_updates()`. The valid prefix can still commit. The public state path reproduced a committed sender balance of 40 while the mempool retained a pending spend of 80. | Preserve successful-prefix balance updates on the failure return. Cover failures after one and several successful blocks, winning and nonwinning prefixes, rollback, and mempool accounting. This affects local transaction selection; normal block validation still checks affordability. |
| 2 | Confirmed transactions consume balance during mempool reconciliation | Append paths call `set_balance` before removing the block's confirmed transactions. With balance 100, a confirmed spend of 60 and pending spend of 20, applying balance 40 evicted the pending transaction even though it remained affordable. The pool ended empty. | Remove confirmed reservations before applying final balances. Audit fork/rollback ordering too. Preserve fee ordering, actual overspend eviction, replacement behavior, and mirrored logs. This also avoids unnecessary sorting and fee-index removals. |
| 2 | Failed-address set loses its sorted invariant | `FlatAddressSet::insert` inserts after `lower_bound` instead of at it. Inserting addresses 3, 1, 2 produced an unsorted vector; two existing addresses were not found, and inserting a duplicate increased size from three to four. | Insert at the lower bound. Test ascending, descending, mixed and duplicate insertion, lookup, and deletion against a reference set. This is a bookkeeping fix; no live peer-selection gain is claimed. |
| 2 | Invalid Janushash input invokes the callback twice | `get_janushash_number("invalid", cb)` called the callback twice. The missing return also continues into hashing a header that parsing did not fully initialize. Valid input called back once. | Return immediately after the parse failure. Test wrong lengths, invalid hex at different positions, valid versions, and exactly one response. The HTTP layer suppresses a second reply once the pending request is removed; that does not prevent the unnecessary hashing or double callback. |
| 2 | Hashrate reporting has two independent arithmetic errors | The chart adds the previous upper header's target, so a difficulty transition enters its sliding sum one block late. Separately, `sum_work` takes its first-retarget exit before respecting a later requested start. At height 718 with a ten-block window, the reported rate was 1,927,367,033 versus an independent per-header sum of 26,843,552. | Correct the incoming upper target and requested-window calculation in the reporting path. Prefer a reporting-specific helper. A shared-helper edit requires proof that all consensus prefix-work results stay identical; changing consensus work is **IMPOSSIBLE CURRENTLY**. Compare scalar/chart results with a per-header oracle across retargets, short histories, window sizes and empty ranges, and retain replay/work invariants. |

### Sources

- Reorg expiry: [fork reconciliation](../src/node/chainserver/state/helpers/consensus.cpp#L33),
  [unfiltered mining selection](../src/node/mempool/mempool.cpp#L28), and
  [failed pin encoding](../src/node/block/body/generator.cpp#L163).
- Partial stage: [failure-path balance extraction](../src/node/chainserver/state/transactions/apply_stage.cpp#L51),
  [successful balance extraction](../src/node/chainserver/state/transactions/apply_stage.cpp#L59), and
  [committing a successful prefix](../src/node/chainserver/state/state.cpp#L504).
- Balance ordering: [multi append](../src/node/chainserver/state/helpers/consensus.cpp#L146),
  [single append](../src/node/chainserver/state/helpers/consensus.cpp#L184), and
  [balance-driven eviction](../src/node/mempool/mempool.cpp#L173).
- Failed addresses: [insertion](../src/node/eventloop/address_manager/flat_address_set.cpp#L10)
  and [failed-address filtering](../src/node/eventloop/address_manager/address_manager.cpp#L283).
- Janushash: [parse and callbacks](../src/node/api/interface.cpp#L94).
- Hashrate: [chart update](../src/node/block/chain/header_chain.cpp#L166)
  and [range-work calculation](../src/node/block/chain/header_chain.cpp#L305).

## Other correctness findings

- **Chain-worker flag access is not synchronized.** Producers write `haswork`
  and `closing` while holding the mutex, but
  [the worker](../src/node/chainserver/server.cpp#L179) clears/reads them after
  releasing it. Both are ordinary `bool`s. Keep predicate checking, reset, close
  handling and queue extraction under the same lock. This is established by
  source inspection; no ThreadSanitizer result or reproducible shutdown hang is
  claimed. Test concurrent producers, idle wakeups and shutdown before adopting.
- **IMPOSSIBLE CURRENTLY — correcting the timestamp maximum changes consensus.**
  [TimestampValidator::append](../src/node/block/header/timestamprule.hpp#L41)
  only assigns `tmax` when it is already greater than the incoming timestamp;
  it starts at zero. After fifty timestamps of 1,000 and one of 10,000, a new
  timestamp of 2,000 passed despite the nominal 600-second drop limit.
  **Excluded from the current fix queue:**
  [header verification](../src/node/block/chain/consensus_headers.cpp#L164)
  uses this validator for consensus acceptance. Enforcing the intended rule
  changes historical acceptance behavior: a peer block accepted by the existing
  rules could be rejected locally. A coordinated network upgrade would be a
  separate project; this defect must remain unchanged in the present work.
- **The header-prefix constructor is broken, but has no current runtime caller
  found in this review.**
  [Headerchain(from, subheight)](../src/node/block/chain/header_chain.cpp#L259)
  copies one too many complete-batch entries and does not initialize `finalPin`.
  Extracting 50 headers from a 100-header chain hits the vector bounds assertion.
  Repair or remove the unused interface before using it for a snapshot shortcut;
  cover zero, partial, exact-batch, and cross-batch prefixes.

## Checks that prevented false positives

- `headerchain = std::move(ad.patchedChain)` currently **copies**: the derived
  chain declares copy operations without corresponding derived move operations.
  A real assignment retained the source's height 8,190 and allocated different
  destination header storage. Thus the subsequent source-length read is not
  currently a demonstrated moved-from bug. Enabling real moves must also change
  that read to the owned chain or capture the length beforehand.
- Single-append pruning differs from admission's next-block threshold at a
  boundary, but the retained transaction in that control still encoded and
  generated a body. It is not the demonstrated reorg template failure.
- `Focus::set_offset` initially looked capable of dereferencing an end iterator.
  Its nonempty-map and slot-order invariants cover that case; no finding is
  reported without an invariant-breaking reproduction.
- Malformed Stratum JSON is caught by the socket data handler. An uncaught JSON
  parse exception was not confirmed as a node-termination bug.

## Reproduction limits and retained evidence

The original discovery container used the baseline runtime implementation, release
optimization with assertions retained, SQLite 3.54.1, a four-CPU quota, 4 GiB RAM,
and no network access. Synthetic funded databases and unmined testnet headers
exercise bookkeeping, reporting and body application; these are not mined reorgs
or a live-network incident reproduction. The stage test uses normal public state
entry points with pre-stored synthetic headers, keeps body/signature checks, and
reproduces a committed valid prefix followed by a balance-invalid body.

Local evidence is retained under the ignored
`build/node-review-bugs-20261020/` directory: harness sources, native binaries,
structured results, build output, and a manifest confirming that 243 container
runtime source files match the checkout. The prefix-constructor failure is a separate
expected-failure process. These are the original discovery reproductions, not
the fix regressions. Evidence for the current focused patch is listed separately
above. Release and deployment evidence is retained separately from this review.
