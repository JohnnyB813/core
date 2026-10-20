# Node optimization future work

Updated on 2026-10-19. The current node runs locally and its API port is not
publicly exposed. The remaining investigations below are deferred; their
conditions and evidence limits are recorded alongside each opportunity.

Implemented local patches and their bounded measurements are documented in
[Transaction admission optimization](transaction-admission-optimization.md),
[Stratum message preparation](stratum-preparation-optimization.md), and
[database maintenance](database-maintenance-optimization.md).

The [block application data-movement screen](block-application-data-movement.md)
did not qualify a body handoff. It also found and corrected a block-height lookup
bug; the remaining performance opportunity is deferred below.

| Area | Opportunity and evidence | First useful experiment | Conditions and limits |
| --- | --- | --- | --- |
| Chain worker and API interference | The chain worker handles block acceptance, mining requests, account/history reads, and their callbacks. HTTP callbacks serialize responses before deferring the socket reply. Transfer serialization to another thread using owned response snapshots; investigate expensive reads, including the richlist balance sort with no balance index in the declared schema. | Measure received-block-to-miner receipt and submission-to-acceptance under representative API traffic. Confirm query plans before considering indexes or separate readers. | Lower priority for the current private local API. Reconsider if local polling becomes substantial or the API is exposed. Any index must also be evaluated for block-write cost; readers must preserve consistent state. |
| Database checkpoint scheduling | WAL is already enabled. Expired maintenance batches now share one pair of cumulative deletes; see the linked maintenance report. Remaining commit tails may include automatic checkpoints. | Correlate commit p95/p99 with checkpoint activity on the deployment storage. Screen bounded background/idle checkpointing only if checkpoints account for meaningful delay. | Keep `synchronous=FULL`, atomic commit, bounded WAL growth, and recovery behavior. The earlier DELETE/WAL storage comparisons did not complete the five-run protocol. Local Docker maintenance gains do not establish RAID or live-mining gains. |
| Block application body handoff (screened) | For 35-KB-bounded bodies, local readback medians were 12.6–60.4 µs. An optimistic direct-use component screen did not qualify on empty, 100-transfer, or 353-transfer bodies. Insert-all/read-all checks with 30 and 300 near-full bodies also showed no costly local readback stall. | Revisit only if deployment-storage attribution shows meaningful readback cost, or separately profile broader API-result copying. | The screen excludes full stage/commit latency and cold deployment storage. A handoff needs bounded borrowed lifetimes, database fallback, and authoritative existing rows. Preserve persistence, fork/rollback handling, and body/header checks. |
| Transaction-heavy block validation | In the signed-body component screen, validation/preparation took about 92% of median populated-body time. That phase includes signature checks, account reads, balance checks, and history construction; pure cryptographic time has not yet been separated. | Split this phase's costs, then screen bounded parallel signature verification only if cryptographic work dominates representative block application. | Preserve all signature, balance, nonce, pin, and account checks, including failure behavior and reorg correctness. Empty or lightly populated blocks may not benefit. |
| Mining template/body/root caching | Existing per-address body caching expires with database/mempool revisions and wall-clock seconds. Broader reuse was tested previously without a qualifying general benefit. | Revisit only for a demonstrated transaction-heavy HTTP-mining workload, separating immutable body data from fresh header timestamps and other validity inputs. | Low priority. Root-only reuse failed controls. Longer body/root reuse did not qualify in completed empty-mempool HTTP tests; signed heavy-template results were incomplete. Do not infer adoption readiness. |

## Evidence and measurement

- [Existing latency and replay guidance](../src/test/README.md).
- [SQLite WAL checkpoint behavior](https://www.sqlite.org/wal.html#performance_considerations).

Start with a small workload-specific screen before a broad qualification run.
Measure externally received fresh jobs and found-block acceptance where applicable;
socket write queueing alone does not establish miner delivery. Report CPU and
memory costs alongside latency, preserve quiet/small-node controls, and distinguish
synthetic or offline gains from live mining outcomes. Peer-selection experiments
remain deferred; existing results do not establish a durable live gain.
