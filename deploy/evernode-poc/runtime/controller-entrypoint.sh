#!/bin/sh
set -eu
# Sashimono invokes the image's first entrypoint executable for both `new` and
# `run`. Keep the original CLI for initialization and supervise only this pilot.
if [ "${1:-}" = run ] && [ "${2:-}" = /contract ]; then
    exec node /app/supervisor.mjs "$@"
fi
exec /usr/local/bin/hotpocket/hpcore "$@"
