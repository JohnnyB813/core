FROM warthog-poc-controller:trial
COPY tests/controller-cli.test.cjs /app/tests/controller-cli.test.cjs
ENTRYPOINT ["node","--test","/app/tests/controller-cli.test.cjs"]
