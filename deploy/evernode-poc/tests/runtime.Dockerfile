FROM warthog-poc-runtime:trial
RUN apk add --no-cache openssl=3.5.9-r0
COPY tests/prepare-runtime.cjs tests/runtime-process.test.ts tests/poller-native.test.ts tests/finite-gateway-process.test.ts ./tests/
RUN node tests/prepare-runtime.cjs && mkdir -p /contract/cfg && openssl req -x509 -newkey ed25519 -nodes -keyout /contract/cfg/tlskey.pem -out /contract/cfg/tlscert.pem -subj /CN=localhost -addext subjectAltName=IP:127.0.0.1 -days 1 && chmod 0600 /contract/cfg/tlskey.pem
ENV NODE_EXTRA_CA_CERTS=/contract/cfg/tlscert.pem
ENTRYPOINT ["node","--test","--test-concurrency=1","tests/runtime-process.test.ts","tests/poller-native.test.ts"]
