# Stratum regression tests

The native Meson suite includes `Stratum job cache`, covering arrival order,
duplicate feeds, chain-tip changes, stale-job removal, and explicit invalidation.
Checks remain active in release builds.

`Stratum work preparation` checks both clean-flag variants, notification fields,
framing, and template immutability. With `-Dperformance-tools=true`, the optional
`stratum_fanout` helper and `run_stratum_preparation_screen.py` measure complete
loopback receiver delivery and server-process CPU. The screen also checks payout
separation, duplicate feeds, reconnects, and a paused receiver. Use it only in an
isolated Linux network namespace; its synthetic jobs are never submitted.
See [method, commands, and measured limits](../../doc/stratum-preparation-optimization.md).

Build and test the runtime locally before publishing:

```sh
docker build . -f dockerfiles/build_linux -t warthog-node:stratum-candidate
python3 src/test/run_stratum_docker.py --image warthog-node:stratum-candidate
```

On Windows, use `python` instead of `python3`. The Docker engine must run Linux
containers. The runner uses a disposable labeled database volume, a node with
`--network none`, and a Python probe sharing only that node's network namespace.
It publishes no host ports and removes its own test resources after checking
their ownership labels. It does not connect to or modify a deployed node.

The socket probe checks authorization-before-job ordering, immediate jobs for
workers sharing a payout address, unique extranonce prefixes, twelve reconnects,
distinct payout addresses, last-worker resubscription, template preservation,
and rejection of unknown jobs and invalid submissions through chain validation.
The previously published `b87fc9ee` image fails the same-address worker check.

The GHCR workflow runs the socket probe against a locally loaded image before
logging in and publishing. The publish build reuses the tested build layers.

These tests use an isolated genesis testnet. They do not measure valid found-block
propagation, mainnet synchronization, or orphan rates.

# Local correctness and worker regressions

`Local correctness addresses` compares insertion, duplicate insertion, lookup,
deletion and clear with `std::set`, across all 720 permutations of six endpoints
and 10,000 deterministic mixed operations. `Local correctness janushash` checks
exactly one callback for malformed lengths and hex, plus unchanged formatted
results for lowercase/uppercase valid headers and both Janushash implementations.

`Chain worker concurrency and shutdown` exercises 200 idle wakeups, 16,000 ordered
callbacks from eight producers, and callbacks that enqueue more work. Linux tests
wrap `pthread_join` to establish that close has been published before releasing a
blocked callback. Forty cases check that the acquired batch finishes, the next
batch stays unexecuted, and queued captures survive until server destruction.
The suite also checks deferred HTTP activation and destruction before activation.
This is functional concurrency coverage; no ThreadSanitizer result is claimed.

# Accepted Stratum submission regressions and profiling

`Stratum submission mainnet` and `Stratum submission testnet` compare 6,800
complete submission/header/body results with the original full-tree calculation,
including one-leaf and odd-leaf trees, version/format boundaries, and historical
fallbacks. They compare notification bytes and verify cached jobs stay immutable.

The optional `stratum_submit_fixture` tool and
`run_stratum_submission_screen.py` exercise real TCP `mining.submit` requests on
the ordinary node. Each newly found block passes the existing PoW, header, Merkle,
signature, balance and commit paths. Both same-payout receivers must receive the
next job; reauthorization, payout changes and stale jobs are checked too. Paired
trials require identical body contents apart from the mining seed and equal final
balances. Admission is sequential so equal-fee transaction ordering is controlled.

The base is a synthetic three-block database with public test keys and an easy
target, rather than a valid network history. The script requires an isolated Linux
namespace exposing only `lo`; it must never run against a connected node. It sets
the fixture's one-unit admission fee through the existing private API. No header,
PoW, signature, ledger, or durability check is disabled in the node.

With `-Dperformance-tools=true`, `stratum_submission_profile` builds a separate
test executable: only its Stratum translation unit redirects the append call to a
timing wrapper, which immediately forwards to the ordinary append implementation.
It records preparation time only after successful validation and durable commit.
Run the screen with `STRATUM_SUBMISSION_PROFILE=1` and that executable to enable
the required existing diagnostic timestamps. The production executable does not
use this wrapper. Whole accepted-block latency and preparation time are separate
measurements; see the [qualification report](../../doc/local-correctness-and-stratum-submission.md).

The offline CI runtime now includes nine accepted Stratum submissions with two
receivers, using empty, 100-transfer and 300-transfer templates. The complete
native suite has 25 tests when Python 3 is available. The earlier genesis socket probe remains a separate
control for reconnects, disconnects and malformed/unknown submissions.

# Mempool reconciliation regressions

The native `mempool_reconciliation` executable provides five default Meson groups:
`append-single`, `append-multi`, `fork-expiry`, `fork-balances`, and `partial-stage`.
They cover confirmed reservations, actual balance-driven eviction, exact remaining
balances, longer/shorter replacement chains, pin-window boundaries, expired and
confirmed rollback transactions, and master/follower log and mining-body equality.

Partial-stage cases run in DELETE and WAL modes with real signatures and normal
body application. They cover balance, signature and duplicate-ID failures after
valid prefixes, a winning fork prefix, a nonwinning fork and failure before any
valid block. Committed ledger/history/undo/work results are compared with a
valid-prefix control; rejected prefixes must leave the original state intact.
Templates selected after reconciliation pass the ordinary body/signature checks
inside a rolled-back test transaction.

Every selected master-mempool sender is also compared with actual signature
recovery after reconciliation. Partial-stage API snapshots check the owned sender
against recovery across successful, rejected and committed-prefix transitions.

Fixtures use public test keys, synthetic funded databases and unmined headers.
They isolate local bookkeeping and do not establish full header/PoW or network
compatibility. Mainnet replay and the existing peer/recovery checks remain
separate controls. Meson gives each group a build-local HOME for its log files;
when invoking the executable directly, use a disposable HOME as well.

# API snapshot and WebSocket regressions

`Mempool API snapshot ownership and senders` checks exact original JSON output
for two funded public fixture keys, pending lookup, fee replacement, pruning and
snapshot lifetime after deletion and overlapping transactions using a reassigned
account ID. Each mempool entry owns the sender verified for that exact transaction.
Linux linker instrumentation verifies that
formatting and pending lookup perform no additional signature recovery. Admission
and block validation retain their signature checks.

`WebSocket subscribers and serialization` uses the `websocket_probe` helper and
Python 3 with real loopback sockets. It checks append/rollback ordering, identical
bytes at two subscribers, an unread client, eight reconnects and removal of the
last subscriber. GCC/libstdc++ Linux linker instrumentation requires zero block/rollback
formatter calls without subscribers and one call per event with subscribers.
The helper binds only `127.0.0.1:34200`; it has no chain database or P2P connection.
This tests one endpoint's subscriber guard, independently of public-listener
event routing. Without Python 3, Meson omits this socket test.

# Latency and durable SQLite tests

The offline replay helper binds a kernel-assigned loopback port because it has
no HTTP clients. CI occupies the former fixed port during genesis replay to
regress collisions with client sockets and later recovery workers.

`Block lookup height and identity` checks stored height independently of row ID,
including reordered fixture inserts, duplicates, restart, and corrupt zero height.
With `-Dperformance-tools=true`, `block_application_profile` and
`run_block_application_profile.py` attribute body readback using genuinely signed
synthetic bodies and the real block applier. This component profile excludes
durable commit and full header/chain acceptance. See the
[data-movement screen and limits](../../doc/block-application-data-movement.md).

`Database maintenance retention and retry` checks expired-batch collection,
protected/canonical/future retention, and retry after failed deletes and commits
in DELETE and WAL modes. `run_db_maintenance_screen.py` performs paired disposable
maintenance timings and genuine block replay; `REPLAY_CHECKPOINT_TRACE=1` enables
test-only checkpoint-copy attribution in `node_replay`. See the
[maintenance method and limits](../../doc/database-maintenance-optimization.md).

The Meson suite also checks the bounded diagnostic queue, monotonic metadata,
nested timings, miner deduplication, peer EWMA/ranking/exploration, journal
conversion, temporary databases, and 360 SQLite write/sync recovery cases,
including forced checkpoint/reset faults and explicitly counted no-fault controls. Assertions
used for test expectations remain active in release builds.

```sh
docker build . -f dockerfiles/build_linux --target test-runtime -t warthog-latency-tests:ci
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp warthog-latency-tests:ci
python3 src/test/config_runtime.py --image warthog-node:stratum-candidate
```

The offline runtime replays 100 genuine public mainnet blocks, checks both peer
policies' handshakes, validated pings and unsolicited-reply rejection, then runs
100 valid local block submissions through HTTP with receiving P2P clients and a
separately recorded stale duplicate. It also runs
40 SIGKILL recovery cases and 28 real chain/state/history recovery cases with
process termination or injected write/sync errors. Recovered chains must retain
acknowledged commits, pass integrity checks, resume through consensus validation,
and match the uninterrupted logical digest. These are not physical power-cut
tests. The historical fixture predates the mainnet checkpoint and current mining
format; the tests do not bypass either rule to manufacture peer or mining success.

Current-height peer and miner tests require a matching database copy and recorded
blocks. The fixture is JSON with `base_height` and `blocks`, where each block is
`[height, header_hex, body_hex]`. Mount the protected base and fixture read-only,
and separate empty volumes at `/trial` and `/results`. Use the test-runtime image:

```sh
python3 /checks/run_latency_benchmarks.py --base=/base --fixture=/fixture/current-blocks.json --trial=/trial --results=/results --runs=5
```

The runner marks its disposable trial directory, checks ownership before resetting
it, and never resets the source. Each comparison starts from the same base. It
rotates case order across five runs, verifies old/new SQLite linkage and logical
equivalence, records 100-block timings, and runs 2,000-transaction workloads across
checkpoint boundaries. Loopback replay peers have equal fast pings and unequal
20/80 ms block responses. Tests verify genuine block acceptance, receiving peers'
announcements, two miners' fresh jobs, bulk scheduling, and invalid nonce/body
rejection. Public/private RPC, P2P and Stratum wire formats are unchanged.

`promotion.json` records all performance gates. A failed performance gate retains
the previous default; any correctness/recovery error stops validation. Do not push
the publishing branch until the current-height RAID tests and local suites pass.
The GHCR workflow repeats the native, configuration, Stratum and offline recovery
suites before registry login and publication.

Current defaults are WAL, diagnostics off, and legacy peer selection. The operator
accepted WAL after two consistent 100-block RAID comparisons and recovery checks,
and stopped further storage repeats. The complete five-run performance protocol
remains available; its unfinished instrumentation and peer-selection gates are not
reported as passed.
