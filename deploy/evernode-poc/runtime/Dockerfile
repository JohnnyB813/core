FROM ghcr.io/johnnyb813/warthog-node@sha256:552d278f7a94cd6f6e096119dda71de5f0ac78200b2eb3d361bb88728e5c6402 AS native
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
RUN apk add --no-cache haproxy=3.4.7-r0 lua5.4-libs=5.4.8-r0 pcre2=10.49-r0
WORKDIR /app
COPY package.json package-lock.json ./
COPY deploy/patch-hotpocket.cjs ./deploy/patch-hotpocket.cjs
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && node deploy/patch-hotpocket.cjs
COPY --from=native /wart-node-linux /wart-node-linux
COPY shared ./shared
COPY controller/registry.ts ./controller/registry.ts
COPY gateway ./gateway
COPY reporter ./reporter
COPY fault ./fault
COPY runtime/*.ts ./runtime/
COPY deploy/pilot-identity.json deploy/fault-operator.json ./deploy/
COPY worker/entrypoint.sh ./worker/entrypoint.sh
RUN chmod 0555 /app/worker/entrypoint.sh && mkdir -p /run/poc /warthog/.warthog /pilotdata
ARG PILOT_RUNTIME=worker
ENV PILOT_RUNTIME=$PILOT_RUNTIME HOME=/warthog
USER root
ENTRYPOINT ["node","runtime/main.ts"]
