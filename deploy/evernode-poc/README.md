# Warthog on Evernode: compatibility milestone

This standalone project contains the first implementation of the proposed Evernode API pool. The current release is a **compatibility gateway**, not a deployed redundant pool. Its default configuration has no workers or controller pins and returns 503 for Warthog reads. It can verify a host's HTTPS routing without admitting an unsynchronized worker.

The application runtime has no homelab or operator-PC dependency. Local builds, private operator setup, and live preflight observations are separate from the rented runtime.

## Implemented and tested

- A HAProxy gateway permits GET requests for `/chain/head`, `/chain/block/:height/hash`, and `/chain/block/:height/header`. It uses least-connections routing, one bounded retry, rate limits, a 256 KiB upstream response limit, and local semantic health checks. `/status` and `/healthz` describe the gateway itself.
- Public full-RPC, wallet, settings, transaction-submission, and fault-control routes are excluded. Local health listeners bind only to loopback.
- Head validation rejects height zero even when `synced` is true, stale observations, wrong network checkpoints, insufficient peers, and lagging or unsupported tips. Three-worker local checks require two workers to agree on a fresh block hash. The external reference is used only for the single-worker compatibility check.
- A deterministic controller reducer accepts only reports whose identities came from HotPocket's authenticated user context. It requires three approved fresh reporters, agrees on a shared probe height, applies three-sample admission/removal thresholds, rejects replays, and retains ten registry snapshots.
- A HotPocket contract adapter uses only the consensus timestamp and consensed inputs when updating state. Read requests do not mutate state. Contract state contains no wallet secrets, private reporter keys, Warthog databases, or raw logs.
- Gateways require four matching replies from five pinned controllers. Local failure can revoke a worker immediately. Quorum loss blocks new admissions; cached serving expires after five minutes. Quorum freshness is exposed for the future lease executor.
- The official HotPocket client is locked at 0.5.7. Its project-local Node transport patch enables certificate verification and limits WebSocket frames to 256 KiB. Source hashes are checked before patching and before connecting. A new, singly pinned client is used for every poll; any disconnect invalidates that poll, preventing automatic UNL trust refresh from broadening a controller identity.
- A two-URL client fails over once for allowed idempotent reads.
- A separate health reporter probes the fixed three-worker set and submits authenticated inputs through a fresh pinned controller connection. Its persistent sequence survives clock rollback, its input and acknowledgment have deadlines, and reconnects cannot broaden a pin. It requires an explicit secret file, retained sequence file, and a current four-controller registry quorum before reporting.

## Current limits

The five-controller Evernode cluster, three-worker fleet, health-report senders, worker fault endpoint, lease executor, and DNS failover are not deployed by this release. Reporter code is locally tested but is not included in the published compatibility gateway's process. The reporter identities are prepared, but their private keys remain in the operator's protected local store until a named deployment authorizes their installation. Wallet seeds are not an input to this software.

The controller logic and SDK adapter are tested locally. Live HotPocket consensus, controller peering, secret installation, and SDK acquisition still need compatibility evidence. No live acquisition or renewal is initiated by the preflight tools.

## Build and verification

Use Node 22.18 or newer:

```text
npm ci --ignore-scripts
npm run prepare-client
npm run check
npm test
npm run build:controller
docker build --platform=linux/amd64 -f deploy/validation.Dockerfile -t warthog-poc-validation .
docker build --platform=linux/amd64 -f gateway/Dockerfile -t warthog-poc-gateway:compat .
docker build --platform=linux/amd64 -f tests/Dockerfile -t warthog-poc-gateway-tests:compat .
docker run --rm --network=none --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=128 --memory=256m --cpus=1 warthog-poc-gateway-tests:compat
```

The container fixtures test actual HAProxy load distribution, upstream failure, bounded retry, no healthy workers, loss of the health agent, method/path boundaries, response limits, rate limiting, and the default closed gateway. The TLS test uses a disposable certificate entirely inside the isolated test container. No host directory is mounted and no host port is published.

The production base image and Alpine packages are pinned. npm dependencies are locked. The controller bundle targets the standard Node 16 HotPocket bootstrap runtime; a live runtime compatibility check remains required. Record the final published container digest before renting.

## Compatibility deployment

Use the unique gateway release tag with these evrPanel switches:

```text
IMAGE--contract--false--gptcp1--8080--proxyssl--false
```

Check the entire image-and-switch string against the host's 128-character limit. Validate the selected host, price, actual tenant quota, unique public IP, lease expiry, and image digest. Prepare a one-hour user-signed rental only after the current worker's full-sync gate passes and the additional charge is approved.

The host should route its HTTPS domain to HTTP port 8080 inside this container. Verify a valid certificate, GET `/status`, and a bounded 503 from `/chain/head`. Neither a 200 status page nor a running container proves worker readiness.

For later fleet configuration, provide a validated JSON file through `PILOT_CONFIG`. Configure exactly five distinct WSS controller origins with unique pinned server keys and exactly three worker origins. The default compatibility configuration never admits traffic. Never bypass certificate validation to make a host pass.

## Operator evidence and private configuration

`deploy/preflight.ts` and `deploy/sdk-host-check.cjs` read an operator-supplied JSON path, defaulting to ignored `.local/operator-trial.json`. Live evidence stays in `evidence/` and is not included in the public source export. The SDK check accepts an account address without a secret and disables its mutation methods. An example operator configuration is in `deploy/operator-example.json`.

`deploy/pilot-identity.json` contains only the new contract ID and reporter public keys. The protected private store is excluded from source exports and Docker contexts. Operator identity preparation is maintained locally; it is not part of the deployed application.

Full acceptance still requires measured catch-up to independent mainnet data, a restart after full sync, verified gateway TLS, SDK acquisition/metadata, live controller quorum and recovery, a capped user-approved fleet allocation, controlled failures, and the planned soak. A short successful storage test is not a substitute for those gates.

## Primary interface references

- https://docs.evernode.org/en/latest/sdk/hotpocket/tutorials/contract-context.html
- https://docs.evernode.org/en/latest/sdk/hotpocket/tutorials/persistdata.html
- https://docs.evernode.org/en/latest/APIs/evernode-js-api.html
- https://docs.warthog.network/guides/node/
- https://www.haproxy.com/documentation/haproxy-configuration-tutorials/reliability/health-checks/
