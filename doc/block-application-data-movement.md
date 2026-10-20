# Block application data movement screen

The single-block screen did not qualify a body handoff for adoption. It also
exposed a block-height lookup bug during the subsequent cache-pressure check;
the small correctness fix is described below.

## Question and scope

`State::add_stage` validates incoming headers and body roots, inserts the blocks
into SQLite, then invokes stage application. `ApplyStageTransaction` retrieves
each block again by hash. `ChainDB::get_block` materializes the header and body
in an owned C++ object, after which `BlockApplier` validates transactions and
writes balances, undo data, consensus references, and history.

The node limits bodies to 35,000 bytes. With the profile's existing accounts,
the modern format uses 32 bytes before its 99-byte transfers, allowing 353
transfers in a 34,979-byte body. Empty bodies omit the transfer count and occupy
28 bytes. This bounds the per-block body data that a handoff could avoid copying.

Before adding a production handoff, the optional `block_application_profile`
helper compares the current insert/read/apply sequence with an optimistic case:
the identical insert and application use the original immutable body directly.
This direct case has no metadata allocation, lookup, identity check, or fallback
overhead. It gives the proposed handoff its best case within this workload.

The running node is unchanged. No body cache or handoff is added. The retained
code adds profiling tools, a lookup regression test, and the height-field fix.

## Method

The helper uses `ChainDB`, the normal body generator, and the real `BlockApplier`.
Three seeded accounts use public test private keys 1, 2, and 3. Transfers have
distinct nonces and genuine recoverable signatures, and all accounts already
exist. Each sample starts from the same funded state, opens a transaction,
inserts a new protected block, optionally retrieves it, and applies its body.
The transaction then rolls back, restoring both database data and cached IDs.

This is a component profile. Seeded balances and unmined testnet headers do not
form a consensus-valid chain. The measurement excludes header/PoW verification,
the initial Merkle check, durable COMMIT, rollback cost, state publication,
network delivery, and miner behavior. The real block-applier signature, balance,
nonce, address, reward, undo, consensus-row, and history work remains enabled.
No production validation rule is changed or bypassed.

Every sample verifies all expected transfers and reward, exact balances and
history counters, the consensus row, stored header/body bytes, undo presence,
and complete restoration after rollback. The initial two samples of each process
also compare every history hash/data pair and exact undo bytes between variants.
Both paths reject an unrecoverable signature. A Linux linker wrapper counts the
real signature-recovery calls and requires exactly one per transfer in every
valid sample. The wrapper always calls the real cryptographic function.

Five runs rotate three profiles: 0 transfers with 2,000 samples per variant,
100 transfers with 512 samples per variant, and 353 transfers with 256 samples
per variant. Each process performs eight warm-up pairs, then alternates which
variant runs first in each measured pair. The two paths share one process and
use new inserts in the same database, with rollback resetting each sample.

Steady-clock timings separate insertion, readback, block application, and the
total interval including disposal of the retrieved body. Process CPU covers the
same total interval. Existing latency scopes split validation/preparation from
state writes. Preparation includes account reads, balance checks, signature
verification, and history construction; it is not a pure cryptographic timer.
All output verification and JSON creation happen outside the timed interval.

A useful screen requires at least a 10% and 100-microsecond reduction in the
median per-run total p95, with at least four of five paired p95 wins. This is an
optimistic component screen, not a qualification of a production candidate.

The build uses the same local Alpine/GCC builder as the earlier patches, with
SQLite 3.54.1 and `synchronous=FULL`. Docker has no network, four CPUs, and a
4-GiB memory limit. Active disposable databases use the container's Linux
filesystem. Only result artifacts are exported to the Windows checkout.
These timings do not characterize the deployment SSD RAID.

## Single-block result

Five runs per profile, with 27,680 timed applications in total. Each transfer's
real signature recovery is counted; the timed samples perform 1,415,680 such
recoveries. The following medians summarize the per-run measurements.

| Transfers | Body bytes | Readback median | Share of component median | Current p95 | Direct-use p95 | p95 change / paired wins |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 28 | 12.574 µs | 9.67% | 178.149 µs | 162.609 µs | -8.72%, 5/5 |
| 100 | 9,932 | 33.469 µs | 0.84% | 4.537 ms | 4.339 ms | -4.38%, 4/5 |
| 353 | 34,979 | 60.390 µs | 0.41% | 16.602 ms | 17.135 ms | +3.21%, 1/5 |

No profile meets the predefined benefit threshold. Median CPU changes from
134 to 121 µs, 4,001 to 3,986 µs, and 14,657.5 to 14,578 µs respectively.
On the two populated profiles, validation/preparation takes median 3.670 ms
and 13.411 ms, versus state-write medians of 0.230 ms and 1.023 ms. Readback is
a small part of those workloads. Peak process RSS ranges up to 57,808 KiB;
both variants share a process, so this is not a memory-savings comparison.

The single-block timings preceded the height-field correction below. In every
sample, the newly inserted row ID and block height are both one, so the original
bug returns the same value as the correction. These measurements do not claim
any performance effect from that correctness fix.

## Batch cache-pressure follow-up

Downloads request up to 30 bodies per batch. The default ten-slot focus window
can coalesce multiple ready batches in `Focus::pop_data`. The follow-up therefore
inserts all rows before reading any, with 30 and 300 copies of the near-full body
under distinct unmined headers. This models approximately 1.05 and 10.49 MB of
body data. It tests physical readback and exact stored bytes, not a valid
multi-block chain or application of all those bodies.

There are five runs per size, each with eight warm-ups and forty measured batches.
The test observes SQLite's cache-miss counter without changing its cache policy.
It times each `get_block` call; comparison of returned bytes occurs outside that
interval. The full-batch total below sums the timed calls and excludes comparison,
insertion, application, and commit.

| Bodies inserted first | Readback median per body | Readback p95 per body | Median total readback per batch | Median SQLite cache misses per batch |
| ---: | ---: | ---: | ---: | ---: |
| 30 | 58.391 µs | 71.837 µs | 1.789 ms | 0 |
| 300 | 29.116 µs | 36.259 µs | 8.727 ms | 2,276 |

These 66,000 measured reads confirm that the larger case exercises SQLite cache
misses. It shows no expensive readback stall in this environment. Its faster
per-body times should not be interpreted as a benefit from cache misses: the
two cases exercise different paging conditions, and the operating system can
still cache recently written data. This does not measure cold deployment storage
or the intervening account/history writes of a complete stage application.

The batch runner is retained as `batch_profile.py` in the artifact directory.
The reusable helper also exposes the raw case directly:

```sh
build/src/node/block_application_profile --batch-readback 300 40
```

## Lookup correctness fix

The hash-lookup query returns `(ROWID, height, header, body)`. Its decoder read
column zero for both `BlockId` and `Block::height`. For example, storing the
recorded height-three block first gives it row ID one, and the original lookup
returns height one. The correction reads height from column one while keeping
the row ID in column zero.

The new native `Block lookup height and identity` regression stores the first
three genuine fixture blocks out of height order. It checks both lookup paths,
height-only lookup, duplicate-header retention of the original stored body,
missing rows, restart, and zero stored-height rejection. It covers temporary,
DELETE, and WAL databases. The existing stage application loop supplies its own
height explicitly, so this is a returned-metadata correction, not a measured
change in block-application speed. No schema, journal, or durability setting
changes.

The original regression binary fails with `expected=3 actual=1`; the corrected
binary passes the new case along with the existing native suites. The only
production runtime edit from this investigation is the height column index.
All ten native suites passed, including the existing 360 SQLite fault-recovery
cases. A fresh 100-block genuine mainnet replay and 28 chain/state/history
recovery cases also passed, preserving the prior logical digest. Post-fix smoke
runs of all three signed-body profiles passed. These are process/I/O recovery
tests, not physical power-cut tests.

## Reproduction

```sh
meson setup build --buildtype=release -Dperformance-tools=true
meson compile -C build block_application_profile
python3 src/test/run_block_application_profile.py \
  --binary build/src/node/block_application_profile \
  --output /artifacts/block-application-data.json
```

Run the full screen on Linux, where the signature-count wrapper is enabled. The
helper creates and removes its own disposable directory; it accepts no existing
database path. To inspect one profile directly:

```sh
build/src/node/block_application_profile 353 256
```

Local source/binary hashes, the build runner, and complete measurements are
retained under ignored `build/block-application-data/`.

## Conditions for a future handoff

A future implementation should pass borrowed bodies only within the synchronous
`add_stage` call and only for rows newly inserted by that call. `insert_protect`
may return an existing database row without replacing its body, so incoming bytes
must not silently replace the authoritative stored bytes in that case. Application
may also need previously persisted stage blocks outside the current input batch;
those need the existing database fallback. Preserve header/body checks, fork and
partial-application behavior, undo, persistence, and commit failure semantics.

Revisit this screen if attribution on deployment storage or another representative
workload shows meaningful readback cost. Broader API-result copying and a full
end-to-end handoff are outside this component measurement.
