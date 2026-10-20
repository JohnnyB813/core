# Stratum message preparation

Validated locally on 2026-10-19. When multiple Stratum connections share one
payout, prepare each required clean/fresh message variant once per dispatch.
Single-connection payouts keep direct preparation. The difficulty and notification
remain one socket write with the same fields and ordering.

Prepared strings live only for that dispatch: at most two flag variants per
payout, with no persistent cache or invalidation policy. Every asynchronous write
still owns its buffer. Existing job-cache, extranonce, authorization, submission,
validation, and queue-milestone behavior is preserved.

The previous recorded candidate had a large fan-out benefit but increased the
one-worker empty-template CPU control by 9.79%, failing its 5% gate. This design
avoids shared-message storage on the one-worker path. The new screen uses a new
harness; it is not a reproduction of the deleted earlier runner.

## Measured results

Five paired repetitions per profile, alternating executable order within each
profile. Values are medians of per-run last-receiver p95 timings and process CPU
measurements. A trigger sends a job to every subscribed payout; timing ends when
all workers have read both complete message lines. Negative CPU changes mean less
CPU. Transfers are synthetic template entries, not admitted signed transactions.

| Workers / payouts / transfers | Triggers/run | Baseline p95 (ms) | Candidate p95 (ms) | Server CPU change |
| --- | ---: | ---: | ---: | ---: |
| 1 / 1 / 0 | 4,000 | 0.174 | 0.174 | -0.17% |
| 1 / 1 / 300 | 1,000 | 0.537 | 0.541 | -0.53% |
| 2 / 1 / 0 | 1,000 | 0.235 | 0.235 | -6.88% |
| 2 / 1 / 300 | 500 | 0.859 | 0.609 | -41.11% |
| 32 / 1 / 300 | 250 | 10.217 | 1.831 | -92.74% |
| 256 / 1 / 0 | 250 | 10.365 | 10.100 | -55.96% |
| 256 / 1 / 300 | 250 | 80.268 | 10.558 | -96.29% |
| 256 / 32 / 300 | 250 | 80.121 | 13.334 | -84.07% |
| 32 / 32 / 300 | 250 | 10.842 | 10.571 | -0.84% |

The one-worker empty-template CPU control was 236.311 ms versus 235.903 ms for
4,000 measured triggers (-0.17%). Its p95 was 174.331 versus 174.011 us. The heavy
one-worker control changed CPU by -0.53% and p95 by +3.618 us. These controls passed
the same 5% CPU regression threshold that rejected the earlier candidate.

The two-worker heavy-template case improved last-receiver p95 by 29.16%; the
32-worker case improved it by 82.08%. Both improved in all five pairs. Empty
templates did not show a qualifying latency improvement, even where CPU decreased.
Payouts with one connection each do not share preparation.

All nine profiles passed CPU and first/last-receiver regression checks. A latency
regression requires an increase exceeding both 5% and 100 us; CPU may not increase
over 5%. A qualifying benefit requires at least 10% and 100 us lower median
per-run p95 and improvement in at least four of five pairs. The maximum increase
in median per-run first-receiver p95 was 61.337 us, within its gate.
The first-receiver gate was additionally evaluated on the saved samples after
the timed run; the retained runner now enforces it during future runs.

## Correctness and limits

- All eight release native Meson suites passed, including sender admission and
  the new work-preparation suite. Serializer tests cover clean=false/true, payout
  and template fields, byte order, message framing, and cached-block immutability.
- Both full-node binaries passed the existing isolated Stratum socket probe:
  authorization ordering, immediate cached jobs, twelve reconnects, unique
  extranonces, payout changes, reauthorization, invalid/unknown submissions,
  twenty-four submit/disconnect cases, and 128 concurrent API requests.
- Every timed received frame was checked against independently computed header
  hashes, Merkle prefixes/roots, targets, timestamps, payout, and job identity.
  Duplicate feeds and cached reconnect jobs were also checked. Runtime frames
  follow the node's existing clean-job policy; both flag values are covered by
  the native serializer test.
- Both variants passed a paused-reader check: eight active receivers continued
  through 500 triggers while another receiver had a small receive buffer and
  paused reads. That receiver subsequently received all 500 unmodified jobs in
  order. Prepared strings had already left scope by then.

This is a bounded 90-run loopback screen, with 20 warm-up triggers per process.
Single-worker controls used 4,000 empty or 1,000 heavy measured triggers per run;
other profiles used the counts in the table. Heavy fan-out profiles used 250
triggers per run, rather than the earlier experiment's 1,000.

The helper links the actual Stratum server, socket writes, and chain subscription
code. Fixture bodies/headers are prepared before timing. It measures feed-to-last
complete probe receipt and fixture-process CPU, excluding the receiving Python
probe's CPU. Receiver scheduling contributes to the absolute timings, especially
for large empty-template fan-out. Upstream block application/template generation,
WAN delivery, actual miner work switching, accepted found blocks, and mining
revenue were not measured. No valid block was submitted by the fixture.

Both variants used the same sources and harness except the two Stratum files;
the existing transaction-admission patch was held constant. Local Docker Desktop
Linux engine, networking disabled, four CPU quota, 4 GiB memory, Alpine 3.23.6,
GCC 15.2.0, release/static builds. The sources were explicitly refreshed between
builds. Native checks and both full-node socket probes completed before timings.
The running node was not changed, and no image was published.

Raw samples, snapshots, source/binary hashes, binaries, and logs are retained in
the Git-ignored `build/stratum-preparation/` directory.

## Reproduce

Build with `-Dperformance-tools=true` and run the native checks:

```sh
meson compile -C build stratum_fanout stratum_preparation
meson test -C build --no-rebuild --print-errorlogs 'Stratum work preparation'
```

In an isolated Linux network namespace with no published ports, compare otherwise
identical baseline/candidate helper binaries:

```sh
python3 src/test/run_stratum_preparation_screen.py --baseline /tools/stratum-fanout-baseline --candidate /tools/stratum-fanout-candidate --output /results/stratum-preparation.json
```

The default screen stops on a regression gate. Exit code 2 means a performance
gate rejected the screen; missing frames, protocol errors, or fixture errors are
failures. `--profiles`, `--runs`, and `--jobs` support smaller exploratory screens;
those results must be labeled with their actual sample counts.

Other deferred areas remain in [Node optimization future work](optimization-future-work.md).
