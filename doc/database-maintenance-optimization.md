# Database commit and maintenance latency

Measured locally on 2026-10-19. The running node was not modified.

## Change

Expired block-retention schedules previously ran the same two cumulative DELETE
statements once per entry. Collection now finds the largest expired deletion key
and executes one pair of statements in one transaction. This preserves the union
of the previous key-prefix deletions, including when key order differs from
expiration order. Protected entries with key zero remain excluded by the existing
SQL. The ten-minute retention period and five-minute maintenance cadence remain.

The collector owns its transaction and opens it only when a schedule has expired.
It retires schedules and cached old-chain ownership after successful commit.
Failed deletes or commits leave these entries available for retry. A multimap
preserves schedules that have the same expiration timestamp.
Schedule insertion also executes independently of whether assertions are enabled.
The two cached DELETE statements are reset after errors so a subsequent attempt
can bind and execute them again while preserving the original exception.

Journal configuration is unchanged: WAL for the configured persistent node,
`synchronous=FULL`, and the existing 1,000-page automatic checkpoint threshold.
The patch adds no database connection, background worker, migration, or setting.

## Validation and measurement

All nine native suites passed. The new maintenance suite passed twelve scenarios,
covering six outcomes in both journal modes. The broader checks also passed the
existing 360 SQLite write/sync recovery cases, 28 chain/state/history recovery
cases, and 40 SIGKILL recovery cases. These test process termination and reported
I/O failures; they are not physical power-cut tests.

The native `Database maintenance retention and retry` suite checks DELETE and WAL
with synthetic retention records. These records exercise bookkeeping, not block
validity. Checks cover empty and future-only schedules, timestamp collisions,
deletion keys out of expiration order, mixed discarded stages and old chains,
re-protected blocks, canonical/protected/future retention, and retry after a failed
second DELETE, rejected commit, write error, partial write, or sync error.

`run_db_maintenance_screen.py` compares separately built baseline and candidate
helpers. The baseline uses the original collector and its original outer
transaction; its only adaptations expose private test fixtures. Each profile has
five paired runs with twenty fresh disposable databases per variant per run. Execution order
alternates within and across runs. Timings include the complete collection and
commit, and exclude fixture creation and verification. SQL tracing counts actual
DELETE statements; process CPU is measured over the same interval. Both versions
verify retained rows, account/history data, integrity, SQLite version, and FULL
durability settings.

Profiles use 5,000 expired 1-KiB synthetic block bodies, with either 200 schedules
or one schedule. With 200 schedules, both contiguous and interleaved row layouts
are tested. DELETE mode provides a compatibility control alongside WAL. The
predefined useful-improvement threshold is a median per-run p95 reduction of at
least 10% and 100 microseconds, with at least four of five paired p95 wins. A p95
increase exceeding both 5% and 100 microseconds is treated as a regression.
The same regression thresholds apply to median process CPU time.

Ten additional runs replay the same 100 genuine historical mainnet blocks through
normal stage and chain-state application. Every replay must produce the same
logical chain/state/history digest. An optional test VFS observes SQLite's
`SQLITE_FCNTL_CKPT_START` signal without replacing the WAL hook or changing the
checkpoint threshold. It classifies block-processing intervals that contain
checkpoint copying; it does not time the complete checkpoint separately. Recorded
commit time is the sum of instrumented commits during block application.

The experiment runs in an offline Linux Docker container on Docker Desktop, with
four CPUs and a 4-GiB memory limit. Active databases live in the container's Linux
filesystem, and only result artifacts are exported to the Windows checkout.
This is a local synthetic maintenance screen, not a measurement on the deployment
SSD RAID or evidence of live miner latency, improved hashrate, or revenue.
Collection still runs on the chain worker, and the transaction's cost still grows
with the number and size of expired blocks. Coalescing removes repeated prefix
deletions; it does not bound a very large collection's duration.

## Measured cleanup results

Median of five per-run p95 values, in milliseconds. Each profile has 200 timed
collections across the two variants, for 1,200 collections in total.

| Journal / layout | Schedules | Baseline p95 | Candidate p95 | p95 change | CPU change |
| --- | ---: | ---: | ---: | ---: | ---: |
| WAL / contiguous | 200 | 80.080 | 22.276 | -72.18% | -34.88% |
| WAL / interleaved | 200 | 75.416 | 34.805 | -53.85% | -61.48% |
| WAL / contiguous | 1 | 20.980 | 21.195 | +1.03% | +0.68% |
| DELETE / contiguous | 200 | 100.773 | 24.335 | -75.85% | -36.99% |
| DELETE / interleaved | 200 | 63.023 | 39.535 | -37.27% | -59.06% |
| DELETE / contiguous | 1 | 24.041 | 23.051 | -4.12% | -0.31% |

All four 200-schedule profiles meet the useful-improvement threshold, with five
of five paired p95 wins. Actual DELETE statements fall from 400 to two. Both
single-schedule profiles fall within the regression thresholds and show no
qualifying improvement; both variants already execute two DELETE statements in
that case. No maintenance profile trips either regression threshold.

## Ordinary block replay and checkpoints

The initial five paired 100-block replays produced median per-run processing p95
of 2.315 ms for baseline and 2.482 ms for candidate (+7.21%). This prompted a
separate, fixed 24-round follow-up with three variants: baseline, candidate, and
an unchanged control using the exact baseline binary. All six execution orders
occur four times, and every process starts with a fresh disposable database.
No production code or compiler settings changed between the initial and follow-up
measurements. The initial results are retained and included in the combined view.

| Replay sample | Baseline p95 | Identical-binary control p95 | Candidate p95 |
| --- | ---: | ---: | ---: |
| Initial five runs per variant | 2.315 ms | — | 2.482 ms |
| Follow-up 24 rounds | 2.844 ms | 2.799 ms | 2.618 ms |
| All 29 baseline/candidate runs | 2.534 ms | — | 2.594 ms |

The combined difference is +60 microseconds (+2.37%); median complete replay time
is 209.438 ms versus 209.693 ms (+0.12%). The follow-up's per-run p95 ranges are
2.182–5.216 ms for baseline, 2.202–5.179 ms for the unchanged control, and
2.136–7.421 ms for candidate. The direction reverses between samples and the
unchanged control also varies substantially. This does not establish a consistent
ordinary-block performance change. No ordinary-block improvement is claimed.
All 82 replays, totaling 8,200 accepted historical blocks, produce the same logical
digest. Full follow-up data and its runner are retained in `replay-controls.json`
and `replay_controls.py` under the artifact directory.

In the initial ten replays, each 100-block sequence contains one observed
checkpoint-copy interval. The associated block-application commit totals are
3.727–4.099 ms, compared with non-checkpoint-block commit medians of 1.651 ms
(baseline) and 1.669 ms (candidate). This confirms occasional checkpoint activity
in this light historical workload. It does not establish a useful gain from
moving checkpoints to another thread, nor represent current-height heavy blocks
or the deployment storage. Checkpoint policy remains unchanged.

## Reproduction

Build with Meson `--buildtype=release -Dperformance-tools=true`, then run the native
suite and preserve separately compiled baseline/candidate binaries. The baseline
test helper is compiled with `GC_REFERENCE_TRANSACTION` and a private fixture
accessor; production SQL and the collection loop remain original.

```sh
meson compile -C build db_maintenance node_replay
meson test -C build --print-errorlogs
python3 src/test/run_db_maintenance_screen.py \
  --baseline /artifacts/db-maintenance-baseline \
  --candidate /artifacts/db-maintenance-candidate \
  --replay-baseline /artifacts/node-replay-baseline \
  --replay-candidate /artifacts/node-replay-candidate \
  --fixture src/test/fixtures/genesis-mainnet.json \
  --output /artifacts/measurements.json
```

Use a disposable local Linux filesystem for the databases. The helpers create
their own new temporary directories. Results and build provenance from this local
experiment are retained under ignored `build/db-maintenance/`.

## Checkpoint follow-up

SQLite's default checkpoint can run in the commit that reaches its WAL threshold.
Moving it to another thread introduces a separate connection, shutdown and error
handling, contention, and WAL-growth policy. That change needs storage-specific
evidence before adoption. Any future experiment must retain FULL commits, account
for total I/O and recovery, and handle readers that prevent checkpoint completion.
See the official [WAL performance discussion](https://www.sqlite.org/wal.html#performance_considerations)
and [checkpoint API](https://www.sqlite.org/c3ref/wal_checkpoint_v2.html).
