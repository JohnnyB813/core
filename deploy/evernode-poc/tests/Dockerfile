FROM warthog-poc-gateway:compat
USER root
RUN apk add --no-cache openssl=3.5.9-r0
RUN mkdir -p /contract/cfg /contract/tls && chown -R node:node /contract
USER node
COPY --chown=node:node tests ./tests
COPY --chown=node:node client ./client
CMD ["node", "--test", "--test-concurrency=1", "tests/gateway-container.test.ts", "tests/tls-container.test.ts", "tests/platform-tls-container.test.ts"]
