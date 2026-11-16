# Warthog on Evernode: compatibility milestone

This standalone project contains the Evernode API pool proof of concept. Its **compatibility gateway** and separately configured pilot runtimes require live acceptance testing before the redundant pool can be considered validated. Its default configuration has no workers or controller pins and returns 503 for Warthog reads. It can verify a host's HTTPS routing without admitting an unsynchronized worker.

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
- The gateway can terminate TLS itself on port 8443 using the platform's certificate files. It reads those files during bootstrap, stages mode-0600 runtime copies, and drops to UID 1000 before starting the agent and HAProxy. Both HTTP/1.1 and HTTP/2 retain the closed-worker 503 response. Missing, expired, or mismatched certificate profiles do not enable this listener.
- A separate health reporter probes the fixed three-worker set and submits authenticated inputs through a fresh pinned controller connection. Its persistent sequence survives clock rollback, its input and acknowledgment have deadlines, and reconnects cannot broaden a pin. It requires an explicit secret file, retained sequence file, and a current four-controller registry quorum before reporting.
- A named host API client verifies the tenant, lease, physical slot, image digest and expiry before a restart. A persistent exclusive claim prevents replay after an uncertain response. One live API restart recovered the same gateway's valid HTTP/1.1 and HTTP/2 service; a startup marker alone was insufficient while the host was still restarting.
- The worker runtime exposes only the three chain read routes and the filtered peer-list read through its direct TLS control listener. The upstream target is a fixed loopback public-RPC port; private RPC, request-supplied URLs, headers and writes are excluded. Time and byte limits bound failed upstream reads. This adapter passed the real Warthog container fixture; live validation of this revision remains pending.
- Resource observations distinguish cgroup v1/v2 limits, unlimited and unavailable limits. A host-provided disk value is labeled unverified; underlying filesystem availability is not treated as an enforced tenant quota. The public diagnostic includes the volume UUID and startup count.
- The separate pilot runtime images package authenticated TLS setup, role-specific reporter keys, persistent sequence state, and signed pause/resume controls for their own application process groups. Private setup is atomic and refuses mismatched identities or replacement keys. Pauses automatically expire, and replayed operations cannot extend them. Non-root isolated fixtures verify real Warthog persistence, mapped P2P settings, reporter startup, gateway reload, proxy pause and restoration.

- Controller deployment uses a deterministic, independently checked ZIP archive and exact BSON bootstrap requests. A pinned owner, contract, image, lease, bundle hash and permanent disk claim bind a one-shot upload; a lost acknowledgment is reconciled instead of replayed.
- The contract retains a separate operation history bound to the unchanged health snapshot hash. The configured owner can authorize one canary policy; only the configured executor can claim and report it. One worker may be excluded for replacement through a fresh, monotonic owner instruction, and readmission requires new report windows. The bounded ledger executor runs separately on G1.
- Future runtimes make a bounded, cached IPv4 egress observation through a fixed HTTPS IP echo service. It runs outside health, consensus and request serving, with at most three startup attempts.

## Current limits

Full redundant-fleet acceptance and client failover require separate live deployment evidence. The compatibility gateway does not run reporters; the separate pilot runtime packages them and waits for authenticated setup. Reporter private keys remain in the operator's protected local store until installed on a named pilot runtime. The finite canary executor, dashboard and offsite load driver require approved installation and live validation. Wallet seeds are not an input to the current runtime.

The pilot worker uses the tested native port-advertisement patch from draft PR #3. Its optional `node.advertise-port` setting preserves the existing handshake format and default behavior, while allowing the public port to differ from the container listener. Native mainnet/testnet handshakes passed in isolated tests; each deployment must verify inbound peering and its allocated advertised port. The controller wrapper builds and parses on the official image's Node 20, but that does not prove live HotPocket/FUSE operation or controller consensus.

The controller logic and SDK adapter are tested locally. Live HotPocket consensus, controller peering, fleet secret installation, and the canary dispatch adapter require live compatibility evidence. Seedless user-signed acquisition and extension have validated ledger responses and matching host readback. No live acquisition or renewal is initiated by the preflight tools. The seedless acquisition requirement builder uses Sashimono’s exact `owner_pubkey`, `contract_id`, `image`, and `config` schema; its output is checked before a user signs a live acquisition.

The direct TLS listener passed a one-hour rented-host compatibility check: normal CA and hostname validation succeeded, HTTP/1.1 and HTTP/2 returned the expected 200/503/403/400 responses, and startup logs confirmed UID 1000. The running image digest matched the tested release. This check used an empty worker set and no controller quorum; it does not prove a deployed API pool. Certificate loading happens at startup; automatic certificate reload is not implemented. Clients must independently verify the CA chain and hostname.

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

The root bootstrap path is separately checked with only the file-ownership, file-access, and user-switch capabilities required by that fixture:

```text
docker run --rm --user=0:0 --network=none --cap-drop=ALL --cap-add=CHOWN --cap-add=SETUID --cap-add=SETGID --cap-add=DAC_OVERRIDE --security-opt=no-new-privileges --pids-limit=128 --memory=256m --cpus=1 warthog-poc-gateway-tests:compat node --test --test-concurrency=1 tests/platform-tls-container.test.ts
```

The production base image and Alpine packages are pinned. npm dependencies are locked. The controller bundle targets Node 16 syntax and is also exercised through the native Node 20 SDK fixture; a live cluster check is required for each deployment. Record the final published container digest before renting.

## Compatibility deployment

Use the unique gateway release tag with these evrPanel switches:

```text
IMAGE--contract--false--gptcp1--8080--proxyssl--false
```

Check the entire image-and-switch string against the host's 128-character limit. Validate the selected host, price, actual tenant quota, unique public IP, lease expiry, and image digest. Prepare a one-hour user-signed rental only after the current worker's full-sync gate passes and the additional charge is approved.

The host should route its HTTPS domain to HTTP port 8080 inside this container. Verify a valid certificate, GET `/status`, and a bounded 503 from `/chain/head`. Neither a 200 status page nor a running container proves worker readiness.

One live host's HTTPS reverse proxy reset a no-worker 503 instead of forwarding it, while the direct HTTP port returned 503 correctly. The two-URL client handled that reset in a read-only reference-fallback test; that was not a multi-Evernode failover test.

For a direct TLS compatibility rental, add a second general TCP mapping:

```text
IMAGE--contract--false--gptcp1--8080--gptcp2--8443--proxyssl--false
```

Use `https://HOST_DOMAIN:ASSIGNED_GPTCP2_PORT/status` and `/chain/head`. This connection terminates in the tenant gateway and avoids the host's application-level HTTPS proxy. The platform profiles are `/contract/cfg/tlscert.pem` plus `tlskey.pem`, and `/contract/tls/fullchain.pem` plus `privkey.pem`. Their originals are never modified. Profiles must have at least two hours of validity remaining; no self-signed trust exception or plaintext client fallback is added. A new trial still needs a concrete approved rental and the user's wallet signature.

For later fleet configuration, provide a validated JSON file through `PILOT_CONFIG`. Configure exactly five distinct WSS controller origins with unique pinned server keys and exactly three worker origins. The default compatibility configuration never admits traffic. Never bypass certificate validation to make a host pass.

## Operator evidence and private configuration

`deploy/preflight.ts` and `deploy/sdk-host-check.cjs` read an operator-supplied JSON path, defaulting to ignored `.local/operator-trial.json`. Live evidence stays in `evidence/` and is not included in the public source export. The SDK check accepts an account address without a secret and disables its mutation methods. An example operator configuration is in `deploy/operator-example.json`.

`deploy/pilot-identity.json` contains only the new contract ID and reporter public keys. The protected private store is excluded from source exports and Docker contexts. Operator identity preparation is maintained locally; it is not part of the deployed application.

Full acceptance still requires measured catch-up to independent mainnet data, a restart after full sync, verified gateway TLS, SDK acquisition/metadata, live controller quorum and recovery, a capped user-approved fleet allocation, controlled failures, and the planned soak. A short successful storage test is not a substitute for those gates.

## Runtime revisions and controller reads

The pilot supervisor supports signed, append-only configuration revisions for a
single worker replacement. Each revision preserves the controller pins, health
policy, initial setup receipt and reporter private key. Worker configuration
changes restart the reporter; gateway changes also reload its proxy. The private
control API reports the installed revision separately from the applied revision.

`deploy/discover-controller.ts` obtains an initial public controller identity
through a certificate-verified WSS connection and a native Ed25519 challenge,
using a disposable client key. All later controller traffic uses that stored pin.
The native initialization fixture exercises the actual `new` and `run /contract`
entrypoint shapes before publishing an image.

The canary modules contain a fixed one-payment policy, paired four-of-five
operation/health checks, independent signed-blob verification and a durable
prepare/dispatch journal. Offline tests cover duplicate callers, restart, lost
submission responses and failed durable writes. A live ledger adapter, bounded
canary funding and installation are separate validation steps; this code alone
does not perform a live renewal.

Controller polling has separate connection, response and disposal deadlines. The
locked Node client validates TLS certificates, caps frames and terminates disposed
sockets when a peer stalls. Isolated TLS fixtures exercise stalled HTTP upgrades
and stalled native handshakes, including actual socket cleanup. The compiled
contract fixture uses native SDK file descriptors under Node 20 and checks
persistent consensus state and unchanged state during read-only queries.

## Finite offsite validation services

The gateway runtime has two separate optional pilot services. G1 accepts one
root-signed canary capability containing one locally signed renewal payment,
its fixed lease and host binding, and its bounded policy. No wallet signing key
is accepted. The service requires a committed claim and fresh paired four-of-five
controller reads before its permanent dispatch claim. After dispatch, a lost
response or process restart only reconciles the saved transaction hash. This
validates one bounded renewal; it does not provide ongoing automatic signing.

G2 accepts one immutable root-signed experiment plan. It fixes ten targets with
distinct declared public IPs, controller pins, HTTPS endpoints and generations.
Every fault action also has its own short-lived operator signature. Late actions
are skipped, and a durable claim prevents replay after an uncertain response.
Pauses expire within eight minutes. The finite driver and its TLS status listener
run outside the gateway application's process group.

The driver measures 9,000 checkpoint-hash reads over fifteen minutes, with at most
two gateway attempts per request and a 32-request concurrency cap. Failed and
missed slots count against the success rate. Its health reads run separately from
the load schedule. A six-hour steady window requires all five controllers, all
three admitted workers, valid target identities and working application processes.
The planned hour without the operator PC is recorded separately; the driver
cannot itself certify that a person physically disconnected that PC or homelab.

`/pilot/dashboard`, `/pilot/experiment` and the bounded JSONL evidence download
are available on G2's direct TLS control origin. Status replies omit installation
payloads, signed capabilities and private keys. G1 exposes only safe canary status
on `/pilot/canary`. The public Warthog gateway continues to exclude these paths.
These services still require live installation and full acceptance evidence.

## Worker response framing

Gateway runtimes normalize each fixed worker through a private loopback read
adapter. The adapter keeps certificate verification for remote HTTPS, permits
only the three chain read routes, forwards no caller credentials, and buffers
at most 256 KiB within a 1.5-second deadline. It validates the response and emits
an explicit byte length. This supports existing workers that use chunked HTTP
without relaxing the outer HAProxy framing or size checks. New worker images
also emit explicit lengths. A real HAProxy regression fixture covers a valid
chunked worker response and rejects an oversized one.

## Primary interface references

- https://docs.evernode.org/en/latest/sdk/hotpocket/tutorials/contract-context.html
- https://docs.evernode.org/en/latest/sdk/hotpocket/tutorials/persistdata.html
- https://docs.evernode.org/en/latest/APIs/evernode-js-api.html
- https://docs.warthog.network/guides/node/
- https://www.haproxy.com/documentation/haproxy-configuration-tutorials/reliability/health-checks/
