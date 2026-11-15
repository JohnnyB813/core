ARG VALIDATION_IMAGE=warthog-poc-validation:ci
FROM ${VALIDATION_IMAGE} AS bundle
FROM warthog-poc-controller:trial
COPY --from=bundle /app/dist/controller/contract.cjs /app/fixture/contract.cjs
COPY tests/native-contract.test.cjs /app/tests/native-contract.test.cjs
COPY deploy/pilot-identity.json /app/deploy/pilot-identity.json
USER 1000:1000
ENTRYPOINT ["node","--test","/app/tests/native-contract.test.cjs"]
