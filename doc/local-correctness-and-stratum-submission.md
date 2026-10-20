# Local node correctness and Stratum submission work

Implemented and validated on 2026-10-20 against `94ced85d`. This report records
the patch and its validation; production deployment is a separate step.

## Fixes

- `FlatAddressSet::insert` now inserts at `lower_bound`, preserving sorted,
  duplicate-free contents and reliable failed-address lookups.
- Invalid Janushash hex returns after its existing empty response. It calls back
  once and does not continue hashing partially parsed bytes. Valid response
  formatting and both underlying hash implementations are unchanged.
- The chain worker reads `closing` and resets `haswork` under the same mutex as
  producers. Queue extraction, garbage collection, event order and transaction
  boundaries retain their existing order. Close still finishes the acquired
  batch and stops before taking the next batch.
- Repeated node starts exposed a pre-existing initialization race: HTTP and
  Stratum listeners could enqueue work before `global_init` finished constructing
  the timing logger. One trial terminated with `std::bad_optional_access` before
  its first submission. Main now constructs HTTP endpoints in deferred mode and
  activates both HTTP and Stratum after globals and the event loop are ready.
  Deferred endpoints also support safe destruction before activation. Existing
  constructor callers retain immediate activation by default.

Both original small-bug regressions failed against the unchanged baseline and
pass with the fixes. The worker stress test also passes against the baseline;
it is regression coverage, not a deterministic data-race reproduction. There is
no ThreadSanitizer claim.

## Cached Stratum preparation

Each job owns its immutable block and the Merkle prefix already needed for its
notification. Notifications reuse that prefix. A submission copies the block,
patches the existing four-byte worker prefix and six-byte extranonce, and hashes
the cached prefix with that ten-byte seed. Historical body/root formats retain
the original full-tree path. Timestamp and nonce byte order are unchanged.

All normal header, PoW, Merkle, signature, balance and commit checks still run on
the chain worker. The cache never substitutes for validation. Duplicate feeds,
latest-job selection, payout separation, tip-change invalidation and owned socket
write buffers retain their existing behavior. The extra prefix payload is only
32 or 64 bytes per existing cached job, plus its vector's storage overhead.

## Qualification through accepted submissions

The optional `stratum_submission_profile` executable compiles the real Stratum
translation unit with only its append call redirected to a test wrapper. That
wrapper times message processing/preparation through the normal append entry,
then immediately forwards to the original chain implementation. It reports a
sample only after the submitted block passes every normal check and commits.
Production `wart-node` does not use this wrapper. Both comparison builds use the
same worker/startup fixes and differ only in the three Stratum cache/server files.

Five paired rounds rotated baseline/candidate order. Each round accepted six
blocks per version at each of 0, 100 and 300 transfers: **180 accepted blocks**.
The first two samples in each process were warmups. Paired body contents beyond
the mining seed and final account balances were identical. Each stored header
matched the independently assembled submitted bytes; two workers received each
new tip. Median-of-round median/p95 preparation times, in microseconds:

| Transfers | Uncached median / p95 | Cached median / p95 | Faster paired rounds |
| --- | --- | --- | --- |
| 0 | 10 / 11 | 9 / 10 | 5/5 |
| 100 | 121.5 / 134 | 10.5 / 14 | 5/5 |
| 300 | 335 / 362 | 33 / 36 | 5/5 |

This qualifies the repeated hashing/preparation saving on real, accepted socket
submissions: about **111 microseconds at 100 transfers** and **302 microseconds
at 300 transfers**. The one-microsecond empty-job difference is not a meaningful
mining performance claim. Prefix construction is performed when registering work
and reused for notification; it is outside the submission interval.

## Whole-request measurements and limits

A separate, uninstrumented five-round comparison accepted 20 blocks per process
and template size, **600 accepted blocks** in total. The first two accepted
samples per process were warmups. Sequential admission and exact paired body
hashes controlled equal-fee ordering. All final balances matched.

| Transfers | Uncached accepted median / p95, ms | Cached accepted median / p95, ms | Faster paired medians |
| --- | --- | --- | --- |
| 0 | 2.160 / 2.703 | 2.111 / 2.852 | 2/5 |
| 100 | 30.788 / 86.485 | 26.858 / 99.659 | 1/5 |
| 300 | 19.859 / 130.835 | 19.432 / 97.875 | 3/5 |

These complete accepted-block times **do not qualify a general latency gain**:
validation, scheduling and FULL/WAL commit tails vary substantially. Neither
aggregate medians nor an isolated favorable round establish a mining advantage.
No propagation, orphan-rate, mainnet throughput or revenue improvement is claimed.

For rejected requests on the same populated jobs, 20 warmups and 200 timed real
socket requests per process gave median-of-round median/p95 times of:

| Transfers | Uncached, microseconds | Cached, microseconds |
| --- | --- | --- |
| 0 | 220.1 / 272.0 | 212.9 / 264.1 |
| 100 | 337.3 / 398.5 | 227.4 / 288.4 |
| 300 | 526.7 / 620.6 | 248.6 / 313.9 |

Both populated cases were faster in all five rounds. Coarse process CPU counters
also decreased, but their 10 ms tick resolution is unsuitable for precise
per-request claims. The accepted-solution preparation profile above is the
qualification result. Earlier concurrent-admission trials were exploratory and
are excluded because transaction ordering was not controlled.

The socket fixture uses public test keys and a synthetic three-block testnet
database with an easy target. Newly submitted blocks use ordinary validation;
the seeded base is not a valid network history. All runs were isolated from
external networking, with four CPUs and 4 GiB RAM. This is not a current-height
mainnet/RAID or mixed-fleet benchmark. Genuine historical replay is a separate
control; no production rule is bypassed to make the fixture work.

## Regression coverage and compatibility

- Address operations match `std::set` across 720 permutations and 10,000 mixed
  operations; malformed/valid Janushash requests preserve response contracts.
- The worker suite checks idle wakeups, 16,000 ordered callbacks, reentrant
  enqueueing, deferred listener activation, repeated idle shutdown, and 40
  deterministic in-flight shutdown/queued-ownership cases on Linux.
- Native Stratum checks compare 6,800 full submissions with the original root
  calculation across mainnet/testnet, one/odd-leaf trees, format/version boundaries
  and historical fallback, including exact notification bytes and immutability.
- All **20 native suites** pass, including reconciliation and SQLite fault cases.
  Offline checks cover 100 genuine historical mainnet blocks, both peer policies,
  100 valid local HTTP submissions with receiving peers, nine accepted Stratum
  submissions with two receivers, 40 SIGKILL cases and 28 chain recovery cases.
- The existing socket probe checks reconnects, resubscription, reauthorization,
  payout changes, 24 submit/disconnect cases and 128 concurrent API requests.

The accepted/rejected block set, ledger and undo rules, work/fork choice,
historical activations and P2P encodings are unchanged. Historical replay retains
the preceding patch's logical digest and exact P2P transcript. Timestamp-rule and
consensus-work changes remain **IMPOSSIBLE CURRENTLY** under the network
compatibility requirement.

Local evidence is under the ignored `build/node-followups-20261020/` directory:
baseline reproductions, source snapshots, native/offline logs, paired result and
preparation summaries, and verification/manifests. No production node was changed.
