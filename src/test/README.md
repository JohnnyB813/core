# Stratum regression tests

The native Meson suite includes `Stratum job cache`, covering arrival order,
duplicate feeds, chain-tip changes, stale-job removal, and explicit invalidation.
Checks remain active in release builds.

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
