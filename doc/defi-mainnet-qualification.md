# Mainnet compatibility testing for the selected DeFi backports

The final correctness-plus-optimization candidate passed compatibility tests with the unchanged official
0.8.20 node in both directions. Each receiver synchronized the same 100 recorded
mainnet blocks, reached the same tip and cumulative work, and produced the same
ledger, history and undo digest. The official peer binary required no update.

Testing completed on 2026-10-20 against our source at
`33ae4cd1396fa634a178c1c66aa7ff90c5f5663e`. Work proceeded through an earlier
six-item prototype, a correctness-only build and the final three narrower
optimizations in the [selection review](defi-mainnet-backport-review.md).
The complete earlier prototype remains a separate
[patch artifact](../build/defi-testing-20261020/candidate.patch). Its three
correctness fixes and the three narrower optimizations are now applied to
workspace source as described below. The public WebSocket delivery repair from
that prototype is separate. Production deployments are unchanged; the running
mainnet test node has since been replaced with the qualified optimization binary,
which also completed the separate one-hour observation below and remains running.

## Correctness implementation

The correctness-only implementation introduced the missing-fee guard, stable timer handles and
inclusive timestamp reconstruction at the requested header prefix. These changes
touch seven runtime files. Ownership moves, verified-sender caching and the public
WebSocket changes were outside that phase. Timestamp acceptance rules,
including `TimestampValidator::tmax`, are unchanged.

Three maintained regressions are registered in Meson and both explicit Docker
test build lists. All 23 native tests passed. The new tests cover 108 fee rejection
cases, 10,000 timers and 131 synthetic chain prefixes with cache reconstruction and
continued appends. Original-code controls reproduce the parser abort, incorrect
prefix state and erased-iterator failure; the fixed implementations pass.
The checked-iterator scheduler probe substitutes only its unused `Request` payload
to avoid unrelated incomplete peer types in debug standard-library containers.

The narrower build also passed 100 real missing-fee HTTP submissions, the existing
offline relay/Stratum/recovery suite, and historical reconstruction at 1,913
prefixes, 1,912 cache lookups and 599 shared-batch boundaries. Its 100-block recent
mainnet replay matched the original build's state digest and serialized P2P bytes.
Both peer directions with unchanged official 0.8.20 then synchronized the same
100 blocks and matched tip, cumulative work, ledger, history and undo. Two Stratum
workers on the updated receiver received the final-tip job.

Implementation evidence, source and binary hashes, binaries and test logs are
retained in the
[implementation manifest](../build/correctness-fixes-20261020/qualification.json)
and its surrounding ignored directory. At that qualification, compiled source
hashes matched the working tree, and the runtime scope check confirmed only the
seven expected files changed from the reviewed baseline.

## One-hour live-mainnet observation

The three-fix binary completed a live-mainnet observation on 2026-10-20 from
16:09:26 through 17:09:26 UTC. The full 3,600-second window began after sync,
HTTP health and two current Stratum job subscriptions were established. The
running executable's SHA-256 matched the qualified binary throughout the checks.

| Observation | Result |
| --- | --- |
| Sampling | 240 observations at approximately 15-second intervals; largest interval 15.091 seconds. |
| Chain progress | Height 5,186,377 to 5,186,533: 156 blocks advanced. |
| Connected peers | 25 to 36, with 33 at the end. |
| HTTP and Stratum | Both HTTP listeners remained responsive; both job probes were current in all 240 observations. No RPC or job-check errors. |
| Process and logs | Same node process, zero container restarts, no OOM events, assertions, database errors or error-level node logs. |
| Node memory | RSS rose from 492.3 to 495.1 MiB, peaking at 495.4 MiB. |
| Node CPU | Process counters recorded 26.72 CPU-seconds between the first and last samples, about 0.75% of one core on average. |

One sample overlapped receipt of block 5,186,477 and saw the node one block behind.
Its logs show sync starting at 16:49:18.817 and completing at 16:49:18.956 UTC,
a 139 ms transition. Both job probes remained current, and the following sample
was fully synced. No prolonged stall or unresolved issue was observed.

The candidate used its own Linux data volume, seeded by a consistent read-only
SQLite backup of the older local mainnet node. At the user's request, that older
node was stopped at 16:12:40 UTC. Observation continued against connected peers'
advertised heights and cumulative work, without restarting the candidate or
resetting the deadline. Expected reference-connection failures from the original
supervisor are preserved separately and are not candidate health failures. The
authoritative continuation records are `active-samples.jsonl` and
`active-summary.json`.

This was one local Linux node with a two-core quota and 3 GiB memory limit under
normal peer traffic and two idle Stratum subscriptions. The probes submitted no
transactions or mining work and injected no faults or deliberate load. These
results support stability under the observed workload; they do not qualify peak
load, active mining throughput, deployment storage or multi-day operation.

At completion the candidate was left running, and the older local mainnet node
remained stopped. The correctness candidate was later stopped cleanly for the
optimization observation below, with its container and data volume retained.
[Final verification](../build/correctness-soak-20261020/final-verification.json)
retains the binary identity, sample coverage, resource measurements and limits.
The same directory contains the raw observations, node logs, monitoring-mode
record and review of the brief sync transition.

## Optimization implementation and validation

The three approved optimizations are applied on top of the preserved,
hour-qualified correctness build. They change nine runtime files: six for sender
reuse, three for stage ownership, and one subscriber guard, with `state.cpp`
shared by the first two changes. This isolated qualification preceded the local
node replacement and observation described below.

Each admitted mempool entry owns the sender already verified for that exact
transaction. Owned API snapshots and pending lookup reuse it. A focused control
rejected the initial payer-wide lookup when two admitted transactions used a
reassigned account ID with different senders; the final per-transaction cache
returns both correct senders. The additional address is internal memory metadata;
the existing transaction serializer still writes exactly its original fields.

The stage patch moves the popped operation into its by-value receiver and moves
local API-block vectors and the final update when their ownership ends. The
downloader's necessary snapshot remains in place. The WebSocket guard runs on
the owning HTTP loop before block/rollback formatting. Public-listener event
routing and the UTC formatter repair remain separate work.

All 25 maintained release tests passed on the final implementation. Sender tests
cover original JSON equivalence, pending lookup, two payers, replacement, pruning,
snapshot lifetime, reassigned IDs and reconciliation after append, fork and
partial-stage transitions. Linux instrumentation observes no extra recovery in
formatting or pending lookup. The real socket regression checks two subscribers,
ordered append/rollback messages, an unread client, eight reconnects, and zero
formatter calls without subscribers. Restoring the original formatter or endpoint
handler makes the corresponding regression fail as expected.

The public API screen used five paired rounds with alternating build order and
fresh copies of the same synthetic funded database. Admission was sequential.
Each pool size had three warmups and 20 measured requests per round: 100 samples
per build and pool size. The normal production executables served real HTTP
requests; no test instrumentation was added to those executables. Full mempool
and pending-transaction response bytes matched the correctness-only baseline.

| Mempool entries | Baseline median / p95, ms | Final candidate median / p95, ms |
| --- | --- | --- |
| 0 | 0.511 / 0.620 | 0.508 / 0.626 |
| 100 | 5.366 / 6.502 | 1.548 / 1.791 |
| 1,000 | 46.984 / 51.479 | 9.320 / 12.623 |
| 2,000 | 94.006 / 102.740 | 19.348 / 26.174 |

Each round also ran four concurrent public mempool pollers, a private head
poller and two Stratum receivers while accepting three fully validated fixture
blocks. Both builds accepted the exact same block bytes, reached the same tip
and cumulative work, and produced the same final ledger digest. All fresh jobs
reached both receivers without RPC errors: 15 accepted blocks and 30 observed
job deliveries per build across the five rounds.

Under that polling load, the median of the five per-round head-response medians
fell from 191.3 to 36.3 ms. The corresponding accepted-block and job-delivery
measurements are retained as small-sample diagnostics in the manifest; they do
not isolate the stage ownership optimization from the API change.

The final binary also passed the offline suite: 100 genesis mainnet blocks, two
peer-policy scenarios, 100 accepted fixture blocks with receiving peers, nine
accepted Stratum submissions with two workers, 40 SIGKILL cases and 28 chain
recovery cases. SIGKILL coverage does not model a power cut. The same 100 recent
mainnet blocks matched the correctness-only build's tip, ledger/history/undo
digest and P2P bytes. Both synchronization directions with the unchanged official
0.8.20 node then matched that tip, cumulative work and complete logical digest.
Two candidate Stratum workers received the final-tip job.

The final node SHA-256 is
`1346d1c1a37952619cfc72d8b02b6e3b9a2b87e75c3a8e8ba23688444cb270ae`.
The [optimization manifest](../build/optimization-validation-20261020/qualification.json)
records matching compiled-source hashes, binary hashes, scope, environment and
all final results. Its surrounding ignored directory retains source snapshots,
the runtime patch, binaries, raw paired timings and test logs. The protected
mainnet backup's SHA-256 remained unchanged. Superseded payer-wide-cache evidence
is explicitly marked as superseded in a separate subdirectory.

An initial offline test start encountered a temporary loopback-port collision
after the HTTP screen. Its failed setup log is retained; the suite passed after
the port became available, and final validation used a bounded port preflight.
The source audit excludes interpreter-generated Python bytecode and checks the
application and maintained test source exactly.

The disposable validation container and its Linux database copies were removed
after evidence collection. The [live-state check](../build/optimization-validation-20261020/live-final-check.json)
confirmed before replacement that the running mainnet process used the hour-qualified correctness
binary with zero restarts or OOM events. The older local mainnet node remains
stopped, and both DeFi testnet containers retain their original running processes.

These are controlled loopback response timings with four CPU quota and 4 GiB
memory, rather than production or mainnet propagation measurements. The small
accepted-block sample establishes progress under this load; it does not qualify
tail propagation latency, orphan rates or mining revenue. No independent
end-to-end stage-move speedup is claimed. Native Windows compilation remains
unqualified. The optimization binary subsequently completed the live observation
below.

## Completed one-hour optimization observation

At the user's request, the local mainnet test service now runs the final
optimization binary in `warthog-optimization-soak-20261020`, labeled
`codex.task=optimization-soak-20261020`, with its dedicated
`warthog-optimization-soak-20261020-data` volume. The binary SHA-256 matches the
optimization manifest. Both previous mainnet containers remain stopped, and the
DeFi testnet node and miner retain their original running processes.

The fixed observation window was 2026-10-20 18:29:51 through 19:29:51 UTC
(2:29:51 through 3:29:51 p.m. EDT), starting at height 5,186,745 after sync,
both HTTP checks and two current Stratum job subscriptions were established.
The [window record](../build/optimization-soak-20261020/window.json) retains the
original deadline and node process identity. The full hour completed with adequate
sampling and no recorded health failures; the deadline was neither reset nor extended.

| Observation | Result |
| --- | --- |
| Sampling | 242 observations spanning 3,600.027 seconds, including the final deadline check; largest interval 15.000356 seconds. |
| Chain progress | Height 5,186,745 to 5,186,907: 162 blocks advanced. |
| Connected peers | 15 to 36, with 33 at the end. Every sample reached at least the best connected peer's advertised height and cumulative work. |
| HTTP and Stratum | Both HTTP listeners remained consistent and responsive, with two current Stratum jobs in every sample. No RPC or job-check errors. |
| Process and logs | Same PID 14 and process start ticks throughout; zero container restarts or OOM events, and no error-level logs, assertions or database errors. Two chain rollback messages occurred without health failures or unresolved lag. |
| Binary and source | Source artifact and running executable retained SHA-256 `1346d1c1a37952619cfc72d8b02b6e3b9a2b87e75c3a8e8ba23688444cb270ae`. At the final checkpoint, all 303 recorded source-file hashes matched the qualified build. |
| Node memory | RSS rose from 491.5 to 494.0 MiB, peaking at 494.4 MiB: 2.5 MiB net growth over the hour. |
| Node CPU | 18.98 CPU-seconds between the first and last samples, about 0.53% of one core on average. |

The final independent checkpoint at 19:31:47 UTC found the same process still
synced and advancing, at height 5,186,913 with matching private/public heads and
33 connected peers. Docker showed zero restarts and no OOM kill. Its approximately
2.485 GiB memory reading includes database file cache from the seed copy; cgroup
statistics showed approximately 522 MiB anonymous memory and 2.47 GiB file cache.
Memory-limit charge/reclaim events occurred, with zero OOM or OOM-kill events.
Process RSS and anonymous memory remained stable; the cache is not evidence of
sustained node heap growth.

The correctness-only node stopped with exit code zero. Its read-only data volume
seeded the replacement through a private database/WAL copy and the SQLite backup
API, followed by a passing `quick_check`. An initial read-only SQLite setup error
occurred before any new node process or timed observation started; that evidence
is preserved separately. The retry used private writable scratch space without
modifying the source volume. One startup HTTP connection refusal also preceded
readiness and the fixed window. These setup records are retained separately from
the successful timed samples. There was no restart of the optimization node
process during the observation window.

The observer sampled every 15 seconds, compared connected peers' advertised
heights and cumulative work, checked both HTTP listeners and two idle Stratum
subscriptions, and recorded continuous process identity, executable hash, logs,
CPU and memory. Independent checkpoints and a ten-minute heartbeat checked the
observer and Docker state. The scheduled heartbeat was paused after final
verification; the healthy optimization node remains running. Both previous
mainnet containers remain stopped, and the DeFi testnet node and miner were
left untouched.

This was one local Linux node with a two-core quota and 3 GiB memory limit under
normal mainnet peer traffic and two idle Stratum subscriptions. Comparison used
connected peers' advertised chain state; the stopped reference nodes provided no
independent live oracle. No transactions or mining work were submitted, and no
faults or deliberate API load were injected. The hour supports stability under
this workload, alongside the isolated tests above; it does not establish peak
API load, active mining throughput, multi-day reliability or propagation gains.

Evidence is retained in the
[completed summary](../build/optimization-soak-20261020/summary.json),
[final verification](../build/optimization-soak-20261020/final-verification.json),
[independent audit](../build/optimization-soak-20261020/final-audit.json),
[raw samples](../build/optimization-soak-20261020/samples.jsonl),
[checkpoints](../build/optimization-soak-20261020/checkpoints.jsonl),
[Docker state](../build/optimization-soak-20261020/docker-state-final.json) and
[Docker resources](../build/optimization-soak-20261020/docker-stats-final.json).

## Earlier six-item prototype results

| Check | Result |
| --- | --- |
| Native release tests | 20 passed on the baseline and 20 on the final candidate. |
| Recent mainnet replay | Both builds accepted blocks 5,181,302 through 5,181,401 from the same protected base. Ledger/history/undo digests and serialized P2P outputs matched exactly. |
| Official node serving the candidate | 100 mainnet blocks synchronized; tip, cumulative work and ledger/history/undo matched. Two candidate Stratum workers received the final-tip job. |
| Candidate serving the official node | The unchanged official 0.8.20 binary synchronized all 100 blocks and produced the same state digest. |
| Historical verifier reconstruction | Zero mismatches at 1,913 prefixes, 1,912 actual cache lookups and 599 shared-batch boundaries, including every existing Janushash activation and the tested retarget/batch edges. |
| Stable timer handles | 10,000 timers passed equal-deadline ordering, cancellation before/after expiry, repeated cancellation and obsolete-handle checks. |
| Missing fee and parser errors | 108 focused rejection cases passed. In the real public HTTP test, the baseline aborted on a missing fee; the candidate returned the existing error for 100 repeated requests and remained responsive. |
| Sender snapshots | A 16-entry, two-payer snapshot matched the original formatter and required zero additional recoveries for formatting or pending lookup. Replacement, pruning and ownership after deletion passed. |
| Sender reuse after reconciliation | 86 comparisons against actual signature recovery passed across all five append, fork and partial-stage regression groups. |
| Real mempool API output | The complete 2,000-entry public response matched baseline bytes exactly. |
| Public WebSocket publication | A normally accepted fixture block produced identical private/public events. Ordered append/rollback sequences, private-only startup, 40 events with an unread subscriber and eight reconnects passed in each listener configuration. |
| No-subscriber serialization | Linker instrumentation observed zero block/rollback formatting calls without subscribers. |
| Offline runtime regressions | 100 genesis mainnet blocks, two peer-policy rejection scenarios, 100 local accepted fixture submissions with receiving peers, nine accepted Stratum submissions with two workers, 40 SIGKILL recovery cases and 28 chain-recovery cases passed. |

The recent mainnet tip was
`d749237c7bf3442b7a38d2e2d80aad5e28b87e0fc3a7e6d4939b2721e23489b2`.
The shared logical digest was
`f91cfe1d37ba9e14d4b9b9ef2f304c2dd19b0a09cf5d4acf7dfd69822069177e`.
The digest covers canonical identities, balances, history, account-history links,
headers, bodies and undo records. Both peer directions also matched
`worksumHex` directly.

## Earlier prototype scope

The earlier six-item prototype added the missing-fee guard, stable timer handles, the inclusive
prefix timestamp window, final ownership transfers, publication to both enabled
HTTP listeners, subscriber checks and owned verified-sender snapshots. It reuses
the verified sender for pending transaction lookup as well as mempool formatting.

The first socket run exposed an additional direct mined-block publication path;
the final candidate covers that path and downloaded-stage publication. UTC
formatting now uses a reentrant conversion because both HTTP loops can serialize
events concurrently. The final native and offline runtime suites and recent
mainnet replay were repeated after those changes.

The patch changes 16 runtime files. It preserves network constants, historical
activations, PoW and signature algorithms, block/body encodings, P2P and Stratum
messages, database schema and FULL durability. In particular, it does not change
the timestamp median/drop rule or repair `TimestampValidator::tmax`.

## Reference peer and fixtures

The reference peer was the Linux executable from the official
[0.8.20 release](https://github.com/warthog-network/core/releases/tag/0.8.20).
Its SHA-256 matched GitHub's published asset digest:
`d6b3c0a85e0b66aaa124c96955452404ba5b962e34a38b2407343bdac82e5a31`.
It reported `wart-node v0.8.20 "0.8.20"` and ran without binary modifications.

Mainnet tests used the existing protected backup at height 5,181,301 and its
matching 100-block recording. Replay and peer nodes wrote only disposable Linux
copies. Historical inspection opened the checkpointed backup with SQLite
read-only immutable access. Synthetic funded fixture databases stayed inside
the offline container.

## Meaning and limits

These results support implementing the selected changes alongside existing
mainnet nodes without a coordinated upgrade. They establish observed
interoperability with official 0.8.20 and equivalence for the recorded history and
tested state transitions; they do not prove every future fork or workload.

The historical oracle traversed the 5,181,301 canonical headers to reconstruct
sequential verifier state. It performed ordinary next-header validation at the
selected prefixes, including PoW, and compared timestamp decisions, target,
retarget state and final hash. This was not a full five-million-block body/PoW
replay. The former initializer rejected actual next headers at many historical
prefixes; the corrected initializer agreed with sequential verification throughout
the tested set.

Offline qualification used Alpine 3.23.6, GCC 15.2, C++20, static release builds
with assertions, SQLite 3.54.1, four CPU quota and 4 GiB RAM. The container had no
external network and published no host ports. The later one-hour live observation
is described above. Native Windows compilation, ThreadSanitizer, multi-day live
operation and deployment-storage performance remain unqualified. No propagation,
orphan-rate or revenue improvement is claimed.

## Earlier prototype evidence

The earlier [qualification.json](../build/defi-testing-20261020/qualification.json) records
source and binary hashes, the exact candidate files, environment and result
summaries. The same ignored directory retains the candidate source snapshots,
patch, baseline/candidate/reference binaries, focused harnesses, native logs,
replay outputs and peer logs. The large disposable database copies were removed
with the test container after collection.
