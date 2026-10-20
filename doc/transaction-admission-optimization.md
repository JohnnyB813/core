# Reuse recovered senders during transaction admission

Validated locally on 2026-10-19. Both `Chainstate::insert_tx` entry points now
recover the transaction sender once and pass that result to a private mempool
helper. The helper still checks the minimum fee and binds the recovered sender
to the database account before reserving balances or changing the pool.

The ordinary public mempool entry point recovers the sender itself, including
rollback/fork reinsertion. There is no persistent verification cache, and block
validation, consensus rules, wire formats, and the deployed node are unchanged.

## Correctness

The release build passed all seven native Meson suites. The new
`Mempool admission signatures` test exercises local/API and peer admission with
real signatures against a synthetic funded temporary database. It checks:

- Successful insertion, returned transaction hashes, and higher-fee replacement.
- Equal/lower-fee rejection, retained balance reservations, and unaffordable replacement.
- Rejection of self-send, zero amount, future pins, unknown accounts, forged sender
  account IDs, changed signed amounts, and unrecoverable signatures.
- Minimum-fee rejection order, with unchanged pool size and update log on rejection.
- Signature verification and forged-account rejection during rollback reinsertion
  and through the ordinary public mempool entry point.

On Linux, a test-only linker wrapper counts actual calls to
`secp256k1_ecdsa_recover`. The same regression harness passed against the baseline
with two recoveries per accepted admission and against the candidate with one.
Other platforms run the behavioral checks without the linker counter.

The fixture uses the first two recorded headers/bodies from
`src/test/fixtures/genesis-mainnet.json` and deliberately seeded account balances.
It is an admission fixture, not a claim of mining or applying a valid funded chain.

## Bounded performance comparison

Five paired repetitions per entry point, with baseline/candidate order and entry
point order reversed on alternating repetitions. Each process warmed up with 256
transactions, then measured 4,096 successful unique-nonce admissions from one
funded sender. Signing and message construction happened before measurement.
Each entry point/build therefore has 20,480 measured admissions.

Values below are medians of the five per-run values. CPU covers each measured
4,096-admission loop; percentiles measure individual `Chainstate::insert_tx` calls.

| Entry point | Baseline p50 | Candidate p50 | Baseline p95 | Candidate p95 | p95 reduction | CPU reduction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Local/API | 72.558 us | 38.162 us | 84.391 us | 47.922 us | 43.21% | 46.66% |
| Peer | 72.950 us | 38.072 us | 85.082 us | 46.098 us | 45.82% | 47.73% |

Both entry points improved p95 in all five paired repetitions. Each measured
baseline loop made 8,192 recoveries; each candidate loop made 4,096.

Environment: local Docker Desktop Linux engine, Alpine 3.23.6, GCC 15.2.0, musl
1.2.5, SQLite 3.54.1, release/static builds, two CPU quota and 3 GiB memory, with
networking disabled. Both binaries used the same harness, dependencies, and
working-tree snapshot based on `c7a5802bce8baff638526e98ebc2c4d84039d8e8`.
The baseline restored only the three initially unchanged admission implementation
files from that commit; the candidate used the edited files. Those files were
explicitly refreshed before recompilation. The linker counter was present in
both timing binaries and is absent from the node executable.

This demonstrates reduced work and elapsed time inside transaction admission.
HTTP/socket transport, mixed senders, sustained external load, block application,
miner job delivery, live hashrate, and stale/orphan rates were not measured.
The absolute p95 reduction was approximately 36–39 us per transaction in this
fixture; the benefit on a quiet node depends on its transaction arrival rate.

Local raw samples, source hashes, scripts, binaries, build output, and native test
logs are retained under the Git-ignored `build/tx-admission/` directory.

## Reproduce the checks

In a configured build:

```sh
meson compile -C build mempool_admission mempool_replacement
meson test -C build --no-rebuild --print-errorlogs 'Mempool admission signatures' 'Mempool replacement accounting'
build/src/node/mempool_admission src/test/fixtures/genesis-mainnet.json --bench api
build/src/node/mempool_admission src/test/fixtures/genesis-mainnet.json --bench peer
```

The benchmark prints one JSON result per process after any startup log messages.
For comparisons, use identical build options and fixtures, rotate execution order,
and compare repeated results rather than one process invocation. The baseline
behavioral check accepts `--expected-recoveries 2`; CI defaults to one.

Deferred investigations are recorded in
[Node optimization future work](optimization-future-work.md).
