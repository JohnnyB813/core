# Node optimization future work

Updated on 2026-10-20. The current node runs locally and its API port is not
publicly exposed. The remaining investigations below are deferred; their
conditions and evidence limits are recorded alongside each opportunity.

The focused reorg-expiry and balance-reconciliation patch is now implemented and
tested; see [patch scope and verification](node-correctness-review.md#focused-reconciliation-patch).
The performance-only candidates below remain deferred.

The [local correctness and Stratum follow-up](local-correctness-and-stratum-submission.md)
implements failed-address insertion, invalid Janushash handling, worker locking
and safe listener startup. It also qualifies cached Merkle-prefix preparation on
accepted Stratum submissions. The saving is bounded to preparation; complete
accepted-block latency and mining gains remain unqualified. These changes passed
local validation; production deployment remains a separate step.

Implemented patches and their bounded measurements are documented in
[Transaction admission optimization](transaction-admission-optimization.md),
[Stratum message preparation](stratum-preparation-optimization.md), and
[database maintenance](database-maintenance-optimization.md).

The [block application data-movement screen](block-application-data-movement.md)
did not qualify a body handoff. It also found and corrected a block-height lookup
bug; the remaining performance opportunity is deferred below.

## Network compatibility review

User requirement, confirmed 2026-10-20: all work must remain compatible with the
other nodes on the existing network, without requiring them to upgrade. Preserve
the existing accepted/rejected block set, deterministic ledger/undo results,
cumulative work and fork choice, historical activation rules, and P2P message
formats. Preserve the Stratum protocol used by existing miners as well.

**IMPOSSIBLE CURRENTLY** marks work excluded from implementation/deployment under
this constraint. A coordinated network-rule change is outside this project.
**Eligible** means the idea can be implemented locally without changing these
contracts. **Conditional** means equivalence on a consensus-sensitive path must
be established before adoption; the existing component screens do not establish
that equivalence on their own.

| Proposed change or group | Compatibility status | Required boundary |
| --- | --- | --- |
| Enforce the intended timestamp maximum/drop limit | **IMPOSSIBLE CURRENTLY** | Correcting `TimestampValidator::tmax` adds a rejection condition that existing nodes do not enforce. Keep this finding excluded from local patches. See the [correctness review](node-correctness-review.md#network-compatibility-requirement). |
| Move stage requests, API results and already-owned header snapshots; add real derived-chain moves | Conditional | Preserve every header/body byte, verifier state, work value, snapshot and asynchronous lifetime. Fix moved-from reads when enabling actual moves. Ownership changes must not change received-block acceptance, rejection height or fork handling. |
| Skip WebSocket serialization with no subscribers | Eligible | Preserve messages for subscribed clients and subscription ordering. Keep chain application/publication decisions unchanged. |
| Move API serialization, tune read queries/richlist indexes, or use consistent readers | Eligible | Preserve response contracts and consistent snapshots. SQL/index changes must produce identical ledger/history/undo data and retain durable transactions. |
| Reuse admitted sender addresses in mempool API snapshots | Eligible | Use the sender verified for that exact transaction/hash; preserve the response. This is formatting reuse, not permission to skip block signature verification. |
| Batch mempool fee-index removals or change its local data structure | Eligible | Preserve pool accounting, fee/replacement behavior and logs. Do not change confirmed transaction-ID replay protection, pin decoding, or block validity. |
| Parallelize independent block signature recovery | Conditional | Run the same checks with the same signed hashes and recovery semantics. Preserve deterministic failure handling and serial state application, including duplicate IDs, balances, rollback and partial-stage behavior. Omitting or weakening consensus checks is **IMPOSSIBLE CURRENTLY**. |
| Broaden mining template/body/root caching | Conditional | Reuse only data valid for the current parent, height, target, timestamp rules and mempool/state revision. Mined blocks must satisfy the existing rules. Changing timestamp, reward, block-size or other validation rules to prolong cache life is **IMPOSSIBLE CURRENTLY**; selecting different template values already allowed by those rules is compatible. |
| Cache a job's Merkle prefix for Stratum submissions | Conditional | Produce the exact existing root/header/body for the same submission, preserve seed partition/byte order, job IDs and Stratum fields, and retain full chain-worker validation. Use the existing network/height-specific Merkle algorithm; applying a different root formula to historical formats is **IMPOSSIBLE CURRENTLY**. |
| Index the mining cache by payout and policy | Eligible | Preserve cache keys, validity/invalidation, selected transactions, payout and response ownership. |
| Compact account/history offset indexes | Conditional | Reproduce every lookup and boundary exactly, including repeated offsets, account-creation heights, pin-dependent checks and rollback. A different account/history mapping that changes block application is **IMPOSSIBLE CURRENTLY**. |
| Change checkpoint scheduling | Eligible | Preserve FULL durable/atomic commits, recovery behavior and bounded WAL growth. This is local storage scheduling, not a consensus change. |
| Shorten old-chain maintenance locks | Conditional | Preserve cache/schedule ownership through commit, consistent reads and pinned header lifetimes. No change to available canonical/protected blocks or fork handling. |
| Hand off block bodies instead of reading them back | Conditional | Use the authoritative existing row when present and preserve all header/body/signature/state checks, durable writes, undo and rollback. Identical block bytes must have identical acceptance and ledger results. |
| Reserve/direct-copy header-serving buffers | Eligible | Return the identical bounded header range and existing P2P encoding. No range/size/protocol rule changes. |
| Reduce redundant cumulative-work integrity rechecks | Conditional | Keep identical target decoding, work accumulation, fork choice and equivalent integrity checks across all activation heights. Changing the work formula, removing required validation, or globally disabling assertions with runtime side effects is **IMPOSSIBLE CURRENTLY**. |
| Revisit peer selection/timing experiments | Eligible within the existing protocol; still deferred | Keep handshakes, message encodings, accepted protocol versions and block validation compatible. No measured live gain currently justifies adoption. |

The [correctness review](node-correctness-review.md#network-compatibility-requirement)
also classifies every bug-fix proposal. Reorg expiry and both balance fixes are
local mempool reconciliation, provided received-block validation and committed
ledger state remain unchanged. The hashrate fix is restricted to reporting;
`sum_work` is also used by consensus integrity checks, so it is not an unrestricted
arithmetic cleanup.

The already implemented admission, Stratum preparation, maintenance and block
lookup patches were also reviewed against this boundary: they reuse a recovery
already performed for the exact transaction, preserve notification fields and
socket ownership, preserve the cumulative deletion set and FULL commits, and
read the stored height from its correct column. None proposes a new network
rule or encoding. This is a source-based compatibility review, with no fresh
mixed-node interoperability result or runtime changes.

## Deferred investigations

| Area | Opportunity and evidence | First useful experiment | Conditions and limits |
| --- | --- | --- | --- |
| Chain worker and API interference | The chain worker handles block acceptance, mining requests, account/history reads, and their callbacks. HTTP callbacks serialize responses before deferring the socket reply. Transfer serialization to another thread using owned response snapshots; investigate expensive reads, including the richlist balance sort with no balance index in the declared schema. | Measure received-block-to-miner receipt and submission-to-acceptance under representative API traffic. Confirm query plans before considering indexes or separate readers. | Lower priority for the current private local API. Reconsider if local polling becomes substantial or the API is exposed. Any index must also be evaluated for block-write cost; readers must preserve consistent state. |
| Database checkpoint scheduling | WAL is already enabled. Expired maintenance batches now share one pair of cumulative deletes; see the linked maintenance report. Remaining commit tails may include automatic checkpoints. | Correlate commit p95/p99 with checkpoint activity on the deployment storage. Screen bounded background/idle checkpointing only if checkpoints account for meaningful delay. | Keep `synchronous=FULL`, atomic commit, bounded WAL growth, and recovery behavior. The earlier DELETE/WAL storage comparisons did not complete the five-run protocol. Local Docker maintenance gains do not establish RAID or live-mining gains. |
| Block application body handoff (screened) | For 35-KB-bounded bodies, local readback medians were 12.6–60.4 µs. An optimistic direct-use component screen did not qualify on empty, 100-transfer, or 353-transfer bodies. Insert-all/read-all checks with 30 and 300 near-full bodies also showed no costly local readback stall. | Revisit only if deployment-storage attribution shows meaningful readback cost, or separately profile broader API-result copying. | The screen excludes full stage/commit latency and cold deployment storage. A handoff needs bounded borrowed lifetimes, database fallback, and authoritative existing rows. Preserve persistence, fork/rollback handling, and body/header checks. |
| Transaction-heavy block validation | The new attribution below separates actual secp256k1 recovery: about 86% of populated-body component time, and 93–94% of validation/preparation. | Screen bounded parallel signature recovery, with a small-block serial path, against representative transaction counts. | Preserve all signature, balance, nonce, pin, and account checks, including failure behavior, atomicity, and reorg correctness. Empty or lightly populated blocks may not benefit. |
| Mining template/body/root caching | Existing per-address body caching expires with database/mempool revisions and wall-clock seconds. Broader reuse was tested previously without a qualifying general benefit. | Revisit only for a demonstrated transaction-heavy HTTP-mining workload, separating immutable body data from fresh header timestamps and other validity inputs. | Low priority. Root-only reuse failed controls. Longer body/root reuse did not qualify in completed empty-mempool HTTP tests; signed heavy-template results were incomplete. Do not infer adoption readiness. |

## Additional source review (2026-10-20)

Reviewed the node at `f57e5edf2c35ba925f31af49b0fed6c1b4e58dab`, including block
application/publication, mining, mempool indexes, database statements and schema,
HTTP/WebSocket serialization, socket buffers/queues, header-chain operations,
timers, and peer bookkeeping. The following are candidates for separate patches.
No production code or deployed node was changed during this review.

The numbers below describe existing component costs in an isolated local Linux
container. They are not measured improvements to block acceptance, miner job
delivery, or revenue. Start with ownership changes, then unused WebSocket work;
prioritize parallel recovery when transaction-heavy blocks are representative.

| Priority | Candidate | Evidence | First patch and qualification |
| --- | --- | --- | --- |
| 1 | Move stage operations and block results at ownership transfers | The event loop passes `*r` into a by-value stage-request parameter, copying bodies and the header snapshot. Applying a stage also returns large API result vectors through lvalue aggregate elements. One 30-block near-full-body operation copy/destruction cost 0.93 ms median / 1.20 ms p95 with a 400-header tail; a 300-block stress case cost 7.97 / 8.44 ms. | Move the popped operation and local result vectors. Preserve the downloader's required live-to-queued header snapshot and every asynchronous object's ownership. Measure received-block-to-miner delivery for single blocks and sync bursts, including batch boundaries and failed partial application. |
| 2 | Skip block WebSocket serialization when nobody subscribes | Each published API block builds JSON, including display hashes and transaction fields, before calling `publish`, without checking subscriber count. The same serializer cost 0.075 ms median for empty, 0.878 ms for 100 transfers, and 2.606 ms for 353 transfers. | On the HTTP loop, check the topic's subscriber count before serializing. Exercise no subscribers, active subscribers, reconnects, forks, and queued subscription changes. This first patch saves HTTP-loop work; it does not remove API-result construction or copies on the chain worker. |
| 3 | Parallelize the expensive part of block validation | Actual recovery time was 3.455 ms of a 4.026 ms 100-transfer application component, and 12.219 ms of 14.139 ms for 353 transfers. The earlier broad validation/preparation timer was not a pure cryptographic timer. | Use a bounded worker pool only for independent signature work. Keep serial controls, all state checks, deterministic failure handling, and transaction rollback. Verify the crypto context's concurrent-use and shutdown contract before implementation. |
| 4 | Batch mempool fee-index removals | `ByFeeDesc::erase` uses `std::erase` on the entire sorted iterator vector. Removing 353 entries from 10,000 performs 3,467,872 equality comparisons and cost about 0.74 ms median / 0.77 ms p95 per index. At 1,000 entries it was only about 65 µs median. Master and event-loop mempools maintain separate indexes. | Screen one-pass removal/compaction for a block or expiry batch before replacing the data structure. Preserve fee ties, replacement/pruning behavior, account balances, index consistency, and log ordering. Measure admission and template traversal as well as deletion; a tree can lose the vector's locality. |
| 5, conditional | Avoid recovering senders again to format mempool API responses | The serializer calls `from_address(txHash)` for every returned entry. The chain-server endpoint permits up to 2,000 entries, while the master mempool already keeps each payer's address in its balance entry. HTTP callbacks serialize before deferring the response. | Include the admitted sender address in the owned API snapshot and preserve the JSON contract. First measure actual local polling and pool size. A complete API-response benchmark was not run; the recovery timings above must not be presented as a measured API speedup. |

### Source locations

- Stage ownership: [event-loop handoff](../src/node/eventloop/eventloop.cpp#L1047),
  [by-value receiver](../src/node/chainserver/server.cpp#L158), and
  [operation payload](../src/node/communication/stage_operation/request.hpp#L12).
  The necessary initial snapshot is created by
  [the downloader](../src/node/eventloop/sync/block_download/block_download.cpp#L65).
- Result ownership: [block-applier result pair](../src/node/chainserver/state/transactions/apply_stage.cpp#L17)
  and [stage result tuple](../src/node/chainserver/state/state.cpp#L504).
  The latter currently returns both `update` and `apiBlocks` as lvalues.
- WebSocket work: [unconditional serialization](../src/node/api/http/endpoint.cpp#L363),
  [queued event ownership](../src/node/api/http/endpoint.hpp#L34), and
  [block JSON](../src/node/api/http/json.cpp#L395). The bundled
  [uWebSockets app](../thirdparty/uWebsockets/include/uwebsockets/App.h#L139)
  exposes `numSubscribers`; use it on its owning loop.
- Signature work: [block preparation](../src/node/chainserver/state/transactions/block_applier.cpp#L224),
  [transfer verification](../src/node/block/chain/history/history.cpp#L4), and
  [recovery](../src/shared/src/crypto/crypto.cpp#L62).
- Mempool scaling: [fee index](../src/node/mempool/txmap.cpp#L20),
  [per-account sorting](../src/node/mempool/txmap.cpp#L6), and
  [block/balance reconciliation](../src/node/chainserver/state/helpers/consensus.cpp#L144).
- Mempool API: [snapshot construction](../src/node/chainserver/state/state.cpp#L714),
  [sender recovery during formatting](../src/node/api/http/json.cpp#L324), and
  [cached balance-entry address](../src/node/mempool/mempool.hpp#L12).

### Smaller or conditional leads

- **Header snapshot size matters even for empty blocks.** With a 400-header
  incomplete tail, copying an empty single-block stage operation cost 26.6 µs
  median / 32.3 µs p95. With 8,639 headers it cost 427 / 456 µs. The incomplete
  header batch can approach 691 KB, whereas the body is capped at 35 KB. These
  measurements support moving an already-owned request; they do not justify
  borrowing the downloader's mutable chain or deleting its snapshot.
- **API result copies grow with batch size.** One copy of a 30-block vector with
  353 transfers per block cost 1.04 ms p95; 300 blocks cost 8.67 ms. These are
  costs of one vector copy/destruction, not additive estimates for a full stage.
- **Cumulative-work integrity rechecks grow with chain history, but were small.**
  [Headerchain::initialize_worksum](../src/node/block/chain/header_chain.cpp#L294)
  computes a cached-prefix result and then calls `sum_work` back to genesis for
  its consistency assertion. Current release settings retain assertions. Real
  methods on synthetic target-correct storage took 2.6 µs median at height
  104,080, 28.9 µs at 1,037,200, and 48.7 µs at 5,184,400. This falls below the
  earlier 100-µs absolute qualification gate for one call; leave it lower priority.
  Any later change must retain equivalent work-accounting invariants and full
  integrity/replay checks rather than disabling consensus checks or assertions
  globally.
- **Header serving allocates incrementally.**
  [get_headers](../src/node/block/chain/header_chain.cpp#L178) copies bytes through
  `back_inserter` without reserving the known bounded result size. Screen an
  exact reserve/direct copy under concurrent header serving; no timing benefit
  was measured here.
- **No new missing rollback-history index was found.** `AccountHistory` already
  has a `history_id` index as well as its account/history primary key. The older
  richlist-sort opportunity remains conditional on API use, with write costs to
  consider. Avoid broad index additions without query-plan evidence.

### Component measurement limits

Five process rounds covered copies, the real block-frame JSON serializer, and
the actual fee-index implementation, with warm-ups and repeated samples. Five
additional runs at each of 0, 100, and 353 transfers instrumented the real
`secp256k1_ecdsa_recover` call in the existing signed-body profile: 1,800 timed
applications and 271,800 timed recoveries. Its history/undo equivalence, balances,
signature counts, invalid-signature rejection, persistence, and rollback checks
remain enabled. The wrapper adds two clock reads per recovery and never skips or
changes verification.

Stage fixtures exercise real copy/move containers with 600 inert complete-batch
views and 400 or 8,639 incomplete headers; these are not validated chains or
reference-count/contention measurements. Move controls preserve body allocations;
copy timings include destruction. API block data comes from the signed-body
applier, but its testnet headers are unmined. Fee-index fixtures isolate index
cost, excluding signature verification and other mempool indexes. The work-sum
fixture uses pinned synthetic batches with constant valid testnet targets; cached
and full sums match, but this is not a mainnet replay or hardfork-boundary test.

Alpine 3.23.6, GCC 15.2, static release, SQLite 3.54.1, four CPU quota, 4 GiB memory,
and no network. Setup, durable commit, real disk latency, full queue scheduling,
and miner delivery are outside these component timings. Raw results, harnesses,
compiled-source snapshots and hashes are retained locally under the ignored
`build/optimization-review-20261020/` directory. Qualify each proposed patch with
paired end-to-end runs before treating these costs as achievable gains.

## Further mining and state review (2026-10-20)

The follow-up [correctness review](node-correctness-review.md) found reproducible
reorg, partial-stage and mempool reconciliation bugs. Those first three fixes are
now implemented and tested in one focused working-tree patch. The performance
opportunities below remain separate, deferred work.

| Candidate | Evidence | Qualification and limits |
| --- | --- | --- |
| Give `ExtendableHeaderchain` actual move operations | The derived class declares copy operations without matching derived moves. A real `dest = std::move(source)` kept the source at height 8,190 and copied its incomplete-header allocation. This occurs inside append/fork reconciliation, beyond the request/result copies identified earlier. | Transfer the verifier and header ownership together, retain the required live stage snapshot, and audit every moved-from read. In particular, multi append currently reads the source length after the apparent move; enabling moves without correcting this would introduce an expiry bug. Use boundary, fork, cumulative-work, template and replay tests, then measure block-to-miner latency. |
| Reuse a cached job's Merkle prefix when preparing a Stratum submission | Implemented and correctness-tested in the follow-up. Five paired rounds on 180 accepted socket submissions measured preparation at 121.5 to 10.5 microseconds for 100 transfers and 335 to 33 microseconds for 300 transfers; all five rounds improved. A separate 600-accepted-block comparison preserved paired bodies and balances. | Full body/root/PoW/signature validation remains intact, with historical-format fallback. Complete accepted-block latency is still unqualified because paired timing and commit tails vary. No empty-job, propagation, orphan-rate or revenue gain is claimed. See the [scope, controls and qualification](local-correctness-and-stratum-submission.md). |
| Index mining-cache entries by payout and transaction policy | `MiningCache::lookup` linearly searches a vector for every payout. A full hit sweep grows quadratically with the number of distinct payout addresses. The screen measured 1, 32, 256 and 1,024 addresses. | Consider a keyed index only for many distinct payouts. The current small local miner setup is unlikely to benefit. Compare complete template dispatch and allocation/RSS with the vector; preserve cache invalidation and response ownership. |
| Compact the per-height account/history offset indexes | `Chainstate` keeps two 64-bit offset vectors with one entry per height. At 5,184,400 headers, their logical element storage alone is 82,950,400 bytes, about 79 MiB, before spare capacity and other structures. Account offsets can repeat over many blocks. | First measure real capacities, RSS and lookup/startup costs. Screen compact deltas or runs with an efficient height index. Preserve `upper_bound` semantics, duplicate offsets, rollback, account-creation heights and history boundaries. This is a calculated storage opportunity, not a measured memory reduction. |
| Shorten the old-chain cache lock around maintenance I/O | `BlockCache::garbage_collect` holds its mutex across cumulative deletes and durable commit; old-chain header/hash readers use the same mutex. | Only pursue if concurrent readers are observably blocked on deployment storage. Keep scheduled entries and cache ownership until commit succeeds, and preserve pinned/owned header lifetimes. No contention timing or implementation was tested here. |

Sources: [derived chain special members](../src/node/block/chain/consensus_headers.hpp#L55),
[append reconciliation](../src/node/chainserver/state/helpers/consensus.cpp#L146),
[Stratum submitted-body/root preparation](../src/node/api/stratum/job_cache.hpp#L25),
[Merkle prefix](../src/shared/src/block/body/view.cpp#L88),
[Merkle root](../src/shared/src/block/body/view.cpp#L121),
[mining-cache lookup](../src/node/chainserver/state/state.cpp#L29),
[offset storage](../src/node/block/chain/offsts.hpp#L7), and
[maintenance lock](../src/node/chainserver/state/helpers/past_chains.cpp#L56).

Median-of-round component results, in microseconds:

| Transfers | Existing body copy + full root, median / p95 | Body copy + cached prefix, median / p95 |
| --- | --- | --- |
| 0 | 1.042 / 1.072 | 0.461 / 0.491 |
| 100 | 88.589 / 99.540 | 0.631 / 0.632 |
| 300 | 287.128 / 315.301 | 27.953 / 30.889 |

For existing mining-cache hit sweeps, median / p95 was 0.020 / 0.030 µs at one
address, 0.471 / 0.481 µs at 32, 24.076 / 24.387 µs at 256, and
379.255 / 400.936 µs at 1,024. These are distinct payouts, not worker counts.

The original discovery submission screen includes body copy/destruction in both paths and excludes
JSON parsing, prefix-cache construction, proof-of-work checks, queueing, durable
commit and network delivery. It uses synthetic notification bodies and real
Merkle methods, not signed transactions or submitted valid solutions. The later
accepted-solution qualification is recorded in the follow-up report above. A prefix
cost is paid when building each cached job; that cost is outside the timed path.
The lookup screen measures only existing cache hits, not body generation or an
alternative data structure. Both use five rounds in one process, 20 warm-ups and 500
timed samples per case per round; results are medians of per-round medians/p95s.
Harnesses, source/binary hashes and raw evidence are retained locally under the
ignored `build/node-review-bugs-20261020/` directory.

## Evidence and measurement

- [Existing latency and replay guidance](../src/test/README.md).
- [SQLite WAL checkpoint behavior](https://www.sqlite.org/wal.html#performance_considerations).

Start with a small workload-specific screen before a broad qualification run.
Measure externally received fresh jobs and found-block acceptance where applicable;
socket write queueing alone does not establish miner delivery. Report CPU and
memory costs alongside latency, preserve quiet/small-node controls, and distinguish
synthetic or offline gains from live mining outcomes. Peer-selection experiments
remain deferred; existing results do not establish a durable live gain.
