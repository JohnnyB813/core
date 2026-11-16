FROM warthog-poc-gateway-tests:compat
COPY --chown=node:node fault ./fault
COPY --chown=node:node reporter/identity.ts ./reporter/identity.ts
COPY --chown=node:node tests/fault-process.test.ts tests/setup.test.ts ./tests/
USER node
CMD ["node","--test","--test-concurrency=1","tests/setup.test.ts","tests/fault-process.test.ts"]
