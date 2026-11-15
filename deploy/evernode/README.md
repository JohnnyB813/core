# Evernode Warthog persistence trial

This trial keeps the exact native Warthog binary already tested on Evernode,
enables its filtered public API, and explicitly persists the database directory
at `/warthog/.warthog`. It uses `chain.db3` and `peers.db3`, matching the prior
custom-command trial. The full RPC listener remains on loopback.

Use the image's entrypoint with `--contract--false`. Set the Evernode volume to
`--vol1--___warthog___.warthog`, not its parent `/warthog`. Record and verify the
published image digest before admitting the instance.

The first start writes a random, nonsecret volume ID and creates Warthog's real
databases with P2P isolated. Restart once through the host panel. The next
startup must log the **same** `volume_id`, `restored=1`, an incremented `starts`
counter, and nonzero database sizes. A restored start permits normal P2P sync.
If storage is discarded, the marker changes and the process stays isolated;
do not accept persistence or spend time on a full sync in that state.

`EVR_FORCE_ISOLATED=1` can hold the node isolated for additional diagnostics.
Only a controlled live restart with stable markers proves host persistence.
The image does not infer that storage is durable merely from a successful
Docker create or a `synced: true` response at genesis.

From this directory, run the local regression test:

```text
docker build -t warthog-evr:storage-fix .
docker pull python:3.14-alpine3.23@sha256:f6a7dec95e6205059dccfcb07faca3ca38729ea35df01231caf1d127bacedec8
python3 test_image.py --image warthog-evr:storage-fix --output local-test-result.json
```

The test uses only newly named/labeled disposable local containers and volumes,
with no network and no host path mounts. It inserts a fixture row into the
actual native SQLite chain database and checks it after restart and recreation.
It also demonstrates that a parent mount permits a separate anonymous child
volume. Its cleanup is restricted to its own verified resources. This test
does not alter the user's live Evernode lease or homelab workloads.
