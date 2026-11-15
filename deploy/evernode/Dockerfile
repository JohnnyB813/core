# syntax=docker/dockerfile:1
FROM ghcr.io/johnnyb813/warthog-node@sha256:cd55da5a24826a7bbdc2e54f8aa755ae9e177b802e473696052b9746c5c6ab69 AS upstream

FROM alpine:3.23.6@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
COPY --from=upstream /wart-node-linux /wart-node-linux
COPY entrypoint.sh /usr/local/bin/evernode-warthog
RUN chmod 0555 /usr/local/bin/evernode-warthog
ENV HOME=/warthog
LABEL org.opencontainers.image.source="https://github.com/JohnnyB813/core"
LABEL org.opencontainers.image.title="Warthog Evernode persistence trial"
VOLUME ["/warthog/.warthog"]
EXPOSE 9186 3001
ENTRYPOINT ["/usr/local/bin/evernode-warthog"]
