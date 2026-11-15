#!/bin/sh
set -eu
umask 077

data=/warthog/.warthog
marker="$data/.evernode-volume-id"
counter="$data/.evernode-start-count"
mkdir -p "$data"

restored=0
if [ -f "$marker" ]; then
    volume_id=$(cat "$marker")
    restored=1
else
    volume_id=$(cat /proc/sys/kernel/random/uuid)
    printf '%s\n' "$volume_id" > "$marker"
fi
case "$volume_id" in
    ''|*[!0-9a-f-]*) echo '[evr] invalid volume marker; refusing to reset it' >&2; exit 1 ;;
esac
[ "${#volume_id}" -eq 36 ] || { echo '[evr] invalid volume marker length' >&2; exit 1; }

starts=0
if [ -f "$counter" ]; then
    starts=$(cat "$counter")
fi
case "$starts" in
    ''|*[!0-9]*) echo '[evr] invalid start counter; refusing to reset it' >&2; exit 1 ;;
esac
[ "${#starts}" -le 9 ] || { echo '[evr] start counter too large' >&2; exit 1; }
starts=$((starts + 1))
printf '%s\n' "$starts" > "$counter.new"
mv "$counter.new" "$counter"
sync

chain_bytes=0
peers_bytes=0
if [ -f "$data/chain.db3" ]; then chain_bytes=$(wc -c < "$data/chain.db3"); fi
if [ -f "$data/peers.db3" ]; then peers_bytes=$(wc -c < "$data/peers.db3"); fi

mode=network
if [ "$restored" -eq 0 ] || [ "$chain_bytes" -eq 0 ] || [ "$peers_bytes" -eq 0 ] || [ "${EVR_FORCE_ISOLATED:-0}" = 1 ]; then
    mode=isolated
fi
printf '[evr] data_dir=%s volume_id=%s restored=%s starts=%s chain_bytes=%s peers_bytes=%s mode=%s\n' \
    "$data" "$volume_id" "$restored" "$starts" "$chain_bytes" "$peers_bytes" "$mode"

set -- /wart-node-linux \
    "--chain-db=$data/chain.db3" \
    "--peers-db=$data/peers.db3" \
    --enable-public "$@"
if [ "$mode" = isolated ]; then
    echo '[evr] cold or incomplete data is isolated; perform one controlled restart and verify the same volume_id and retained database files before accepting persistence'
    set -- "$@" --isolated
fi
exec "$@"
