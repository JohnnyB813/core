# DeFi beta backports for the current mainnet

Select the stable timer-handle design from DeFi, and adapt its header-verifier
reconstruction fix with an inclusive timestamp window. Keep our current mainnet
runtime and protocols. The best additional performance work is targeted ownership
and API optimization in our existing code; the beta does not resolve several of
those costs.

This review and patch selection is dated 2026-10-20. The missing-fee guard,
stable timer handles and verifier prefix repair have since been applied to the
working tree with regression tests. The local correctness build has completed a
one-hour mainnet observation; production deployments are unchanged.

The three subsequently approved optimizations are also applied: verified-sender
reuse, final stage ownership transfers, and the no-subscriber serialization guard.
They passed validation against the preserved correctness-only build. The
local mainnet test node now uses the qualified optimization binary, which completed
its separate one-hour observation with 162 blocks advanced and no recorded health
failures. It remains running; results and limits are recorded in the testing follow-up.

The [testing follow-up](defi-mainnet-qualification.md) records a passing isolated
candidate, including historical verifier checks and synchronization in both
directions with the unchanged official 0.8.20 node. The complete six-item candidate
remains a separate patch artifact. Public-listener WebSocket event routing and
its UTC formatter repair remain outside the current implementation.

## Compared builds

| Build | Source | Version |
| --- | --- | --- |
| Our `dev` | `33ae4cd1396fa634a178c1c66aa7ff90c5f5663e` | 0.8.20 plus local correctness, latency, database and Stratum changes |
| Current upstream mainnet `master` | `54403b863c2cbd47da2e1414a0362a4c8bf01a03` | 0.8.20 |
| Current upstream `defi` | `f19edcde203458c4ed2cd015def7527594b0fa91` | 0.10.30 |

GitHub's live branch/release APIs confirmed these upstream heads and
[DeFi beta 0.10.30](https://github.com/warthog-network/core/releases/tag/0.10.30),
published 2026-09-26. Its release tag resolves to the mainnet master commit, while
the [DeFi release workflow](https://github.com/warthog-network/core/blob/f19edcde203458c4ed2cd015def7527594b0fa91/.github/workflows/release-defi.yml)
builds the checked-out `defi` branch. Therefore the comparison uses the pinned
DeFi source, rather than treating the release tag as its source identity. Exact
released-binary provenance is not established by the tag.

There are 639 commits reachable from DeFi but absent from our HEAD, including
older network-refactor history. This is not a queue of independent mainnet
backports. Upstream's
[README](https://github.com/warthog-network/core/blob/f19edcde203458c4ed2cd015def7527594b0fa91/README.md)
identifies the DeFi branch as testnet software.

## Selected work

| Order | Change | Origin and value | Mainnet boundary |
| --- | --- | --- | --- |
| 1 | Reject a missing transaction fee before dereferencing the optional | Local fix required in both builds. Our existing public API review reproduced a node abort. DeFi's `JSONConverter::fee()` retains the same unchecked optional. | Return `EBADFEE`; retain `fee`/`feeE8`, exact compact fees, valid transaction hashes, signatures and admission rules. Do this before public API exposure. |
| 2 | Replace saved timer iterators with stable keys | DeFi backport by design, especially `5a994fda`. Our scheduler invalidates saved iterators when it collects expired events; peer cleanup can subsequently cancel one. The isolated check fails in our scheduler and passes in DeFi's scheduler. | Keep current timeout durations, event order, active-request accounting and P2P messages. Adapt the timer owners in `conndata`, peer erasure, ping and reconnect handling together. |
| 3 | Reconstruct the verifier from the requested prefix | Adapt `8fd8117e` and the bounds correction in `a73c6cda`. Our initializer takes timestamps from the entire chain's tail, even when the matched prefix ends earlier. The beta replacement has a separate endpoint error. | Reproduce the existing sequential verifier at that prefix, including hash, target and timestamp decisions. Preserve the current timestamp rule itself. This remains conditional on historical and mixed-node qualification. |
| 4 | Move stage requests and owned result vectors at their final handoff | Small local optimization. DeFi moves its final appended-block vector, but still passes `*r` into the by-value stage receiver. Our request and aggregate-return sites still copy owned bodies, headers and API blocks. | Move only an object whose ownership is ending. Preserve the downloader's necessary snapshot and all asynchronous lifetimes, partial-failure results and durable transactions. |
| 5 | Fix public WebSocket event delivery and skip serialization without subscribers | Local patch; DeFi also routes native publication through one global HTTP endpoint, so its subscription rewrite is not a ready fix. Our existing API review reproduced missing public events. | Deliver owned events to both enabled listeners in order. Check subscribers on each listener's owning loop before formatting. Preserve existing JSON, rollback/append order and backpressure behavior. |
| 6 | Reuse admitted sender addresses in mempool API snapshots | Local optimization for the planned public API. The master mempool already owns verified payer addresses; response formatting recovers them again. The earlier prototype preserved output bytes and substantially reduced formatting cost. | Carry the address verified for that exact transaction into an owned snapshot. Cover multiple payers, replacement, expiry, rollback and pending lookup. Keep admission and block signature verification intact. |

Items 1, 2 and 5 are reliability priorities. Item 3 warrants a separate patch and
stronger consensus-equivalence qualification. Items 4 and 6 should be qualified
against representative block and API workloads before claiming a latency gain.
The prior [ownership screens](optimization-future-work.md#additional-source-review-2026-10-20)
and [public API measurements](defi-mainnet-qualification.md#optimization-implementation-and-validation) support their
selection; their component timings are not measured mainnet propagation savings.

## Optimization order after correctness qualification

The three correctness fixes have passed their separate replay, interoperability
and one-hour live-mainnet checks in the [qualification report](defi-mainnet-qualification.md).
The three optimization designs have now been applied to the workspace runtime
on top of those correctness fixes. The qualified optimization build completed its
local one-hour mainnet observation and remains running.

For the planned public API, start with sender reuse. For block-receiving work,
the narrow stage ownership changes are the next candidate. The subscriber guard
is a small HTTP-loop cleanup. Each should remain an independently reviewable
change on top of the qualified correctness fixes.

| Priority | Concrete scope | Evidence and design | Final qualification and limits |
| --- | --- | --- | --- |
| 1 | Store the sender verified at admission with its exact mempool transaction, carry it into each owned API entry, and reuse it for pending lookup. Six runtime files; preserve admission and block signature checks. | Multiple payers, replacement, pruning, snapshot lifetime and reconciliation match actual recovery. A focused reused-account-ID control rejected a payer-wide lookup; each transaction now owns its verified sender. | Five paired rounds at 0, 100, 1,000 and 2,000 entries preserved complete response bytes. At 2,000 entries, median response time fell from 94.0 to 19.3 ms. Four concurrent mempool clients retained head responsiveness, accepted-block progress and fresh jobs at two Stratum receivers. These are controlled loopback measurements. |
| 2 | Move the popped stage operation into the by-value receiver; move local API-block vectors and the final update at their ending ownership boundaries. Three runtime files. | The baseline sites copy; the final patch moves their ending ownership. A prior 30-block operation copy/destruction screen cost 0.93 ms median / 1.20 ms p95. Empty single-block copies also grew with the incomplete header tail. | Final native append/fork/partial-stage tests, offline relay/recovery, recent-mainnet replay and official-node synchronization in both directions passed. The downloader's necessary snapshot remains. No independent end-to-end stage speedup is established; near-full header-batch performance remains outside this qualification. |
| 3 | Check subscriber counts on the owning HTTP loop before block/rollback JSON formatting. One runtime file. | Final linker instrumentation observed zero block/rollback formatter calls without subscribers, and one call per event with subscribers. Prior block-JSON screens cost 0.075 ms for empty blocks through 2.606 ms for a near-full block. | The maintained socket test passed ordered append/rollback delivery at two clients, 40 events with an unread client, eight reconnects and last-subscriber removal. Restoring the original handler fails the zero-subscriber check. API-result construction and queue copies still occur. |

The existing public WebSocket delivery defect is separate from the subscriber
optimization. Its tested repair also routes events to the enabled public listener
and makes UTC formatting safe across the two HTTP loops. Keep that behavior fix
separately identified before relying on public subscriptions.

After sender reuse, remeasure chain-worker interference before introducing JSON
workers or response coalescing. The prior unoptimized polling screen demonstrated
large head-request delays, but it does not establish the residual cost after the
smaller patch. Keep rich-list indexes, persistent HTTP connections, parallel block
signature recovery and actual derived-chain moves in their separate qualification
tracks. The older warning about reading the source length after a move is already
resolved in current append reconciliation, which reads the destination's length.
Actual derived moves still require transferring the verifier and header ownership
together and auditing all remaining lifetimes and moved-from uses.

These selected designs preserve current validation, ledger/undo behavior and
P2P/Stratum formats and can be implemented without other node runners upgrading.
Their earlier combined-prototype compatibility result is useful evidence; each
final implementation is qualified against the preserved correctness-only baseline
in the testing follow-up.
No block-propagation, orphan-rate or mining-revenue improvement is established.

## Timer evidence and adaptation

Our [expiry collection](../src/node/eventloop/timer.cpp#L4) erases all expired
entries before handlers run. The [saved handles](../src/node/eventloop/types/conndata.hpp#L10)
are map iterators, and [peer erasure](../src/node/eventloop/eventloop.cpp#L468)
cancels both ping and request timers. If both have already been collected, handling
one timeout can leave cleanup using the other erased iterator.

A standalone check schedules `CloseNoPong` and `CloseNoReply` for one peer at the
same already-expired deadline. Cancellation before collection succeeds. After
collection, cancellation of the saved job handle aborts under libstdc++ checked
iterators with an invalid-iterator diagnostic. DeFi's current timer implementation
passes both controls with C++20 compilation. This establishes the scheduler defect
and the safe-key behavior; full event-loop integration is still required.

Use an optional stable handle and idempotent cancellation. A wide unsigned
generation counter with collision handling avoids copying the beta's signed
`int keyExtra++` overflow issue into a long-running node. Test simultaneous expiry,
disconnect during expiry handling, late replies, repeated cancellation, reconnects,
shutdown and active-request counts. Newer callback, WebRTC and transport machinery
is unnecessary for this backport.

## Verifier evidence and adaptation

[Our initializer](../src/node/block/chain/consensus_headers.cpp#L181) sets the
requested hash and height but fills the timestamp ring from the full chain's
incomplete batch and preceding complete batch. The live
[cache lookup](../src/node/eventloop/chain_cache.cpp#L102) can call it with a match
below the tip. This is distinct from the previously documented, unused
`Headerchain(chain, subheight)` constructor.

For prefix length `L` and timestamp window `N`, reconstruct timestamps from
`max(1, L - N + 1)` through `L`, inclusive. For `L = 0`, append no timestamps.
DeFi's replacement iterates to `h < length`, omitting the prefix's last header;
for longer prefixes it includes an earlier header instead. Copying that loop
verbatim does not reproduce sequential verification.

Fresh fixtures use target-correct, linked but unmined headers with both mainnet
and testnet parameters. Each mode checks 24 cases: chain lengths 100, 8,640 and
8,690, with prefixes 0, 1, 25, 49, 50, 51, tip minus one and tip. The oracle
advances the ordinary verifier sequentially through the same prefix. It compares
timestamp samples and decisions, target and final hash.

| Initializer | Timestamp-window mismatches per network | Timestamp-decision mismatches per network |
| --- | --- | --- |
| Current mainnet build | 21 of 24 | 21 of 24 |
| DeFi replacement loop adapted to our types | 21 of 24 | 18 of 24 |
| Corrected inclusive loop | 0 of 24 | 0 of 24 |

Mainnet and testnet modes produced the same counts. Every variant matched the
oracle's target and final hash in all 48 cases; only the corrected inclusive loop
also matched every timestamp window and decision. These are reconstruction
checks, not 48 accepted-block tests.

These fixtures isolate reconstruction and do not validate proof of work or replay
mainnet history. Before adoption, cover retarget and every Janushash activation
boundary with valid historical headers, shared-batch reconstruction, restart,
forks and the actual cache-reuse path. Preserve accepted/rejected header outcomes
against the ordinary sequential mainnet verifier. Do not alter
`TimestampValidator::tmax`, its median/drop rule, PoW checks or target formulas.

## Changes already covered by our build

| Beta improvement or older fix | Our status |
| --- | --- |
| Hash lookup reads stored height rather than block row ID | Already fixed and regression-tested locally. |
| Mempool last-entry balance use after erase, `dbd0ebcb` | The `allErased` short-circuit is already present. |
| Reorg reinsertion and expiry handling | Our recent reconciliation patch covers mainnet pin windows, balances, confirmed reservations and partial-stage commits. DeFi's asset-aware rewrite is unnecessary. |
| Fake-total-work protection | Retained upstream mainnet protection plus our final-probe and mismatch fixes. |
| SQLite dependency and maintenance | Our SQLite is 3.54.1 with durable WAL and local maintenance changes; DeFi pins 3.45.1. Porting its wrap would downgrade us. |
| Worker startup, same-payout jobs, notification preparation and submitted-root preparation | Our local regression suite and cached-prefix implementation should be retained. The beta Stratum rewrite is not a demonstrated upgrade. |

## Optional and deferred changes

- A public `/version` alias from `f0ac26ba` is a small operational convenience.
  Retain `/tools/version` and its existing response. Add it when a health-check
  consumer needs it; no mining improvement is claimed.
- Browser CORS/preflight support from `d9f2e2f3` is useful for a public browser
  client. Scope origins and enabled routes deliberately. Do not copy the beta's
  wildcard-origin policy onto private RPC as part of an unrelated optimization.
- Keep hashrate arithmetic repairs in a reporting-only patch. Beta's newer
  hashrate endpoints do not fix our chart's old-upper-target update, and its chart
  still contains that pattern. Do not change shared consensus work accumulation
  to make an API estimate look right.
- Both branches still use vector-based `ByFeeDesc::erase` with a whole-vector
  search. A DeFi mempool merge does not remove that scaling cost. Screen bounded
  batch compaction separately if pool sizes justify it.
- Actual derived-chain moves, parallel signature recovery, broader template
  caching, body handoff and shortened database locks retain the conditions in
  [the existing optimization review](optimization-future-work.md). The beta does
  not establish a measured benefit for our workloads.

## Excluded from the current mainnet selection

Do not merge DeFi as a whole or copy its asset/order/liquidity ledger, database
schema, transaction/body encodings, token activation height, new block versions,
V3 initialization protocol or testnet PoW behavior. Keep our mainnet activation
schedule and existing miner/P2P contracts. C++23, Glaze, browser nodes, WebRTC,
session-directory migration and the TUI wallet are unrelated platform changes,
not prerequisites for the selected fixes.

Also exclude the beta file-lock change that silently returns when opening the
lock target fails. Preserve explicit lock failures rather than treating that
change as a startup optimization. Retain our durability, shutdown and worker
ordering guarantees.

## Verification and patch sequence

Fresh source and scheduler/reconstruction evidence is retained under the ignored
`build/defi-backport-review-20261020/` directory, including harnesses, compiled
variants, source hashes, logs and `summary.json`. The container had no network,
used a read-only repository mount and wrote only review artifacts. Relevant
reused builder sources matched the current checkout byte for byte.
The timer probe decouples its unused `Request` payload from unrelated node headers
so checked standard-library iterators can compile; scheduler code and the tested
ping/request-timeout payloads retain their source implementations.

Implement missing-fee handling and API admission limits first for a public API;
then stable timer handles, followed by the separately qualified verifier repair.
Fix public event delivery before relying on WebSocket consumers. Qualify ownership
moves and sender reuse as focused performance patches. Preserve the native suite,
offline Stratum and reconciliation controls, FULL/WAL crash recovery and mainnet
replay; add the targeted tests above and mixed-version peer synchronization for
the networking/verifier patches. Measure block progress and miner job delivery
under API load before promoting performance changes.
