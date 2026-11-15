FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS bundle
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY shared ./shared
COPY controller/registry.ts ./controller/registry.ts
COPY gateway ./gateway
COPY reporter ./reporter
COPY fault ./fault
COPY runtime ./runtime
COPY deploy/pilot-identity.json deploy/fault-operator.json ./deploy/
RUN ./node_modules/.bin/esbuild runtime/main.ts --bundle --platform=node --target=node20 --format=esm --outfile=/bundle/supervisor.mjs
FROM evernode/sashimono@sha256:f65983ccbe6c99886b0c2b121e5891ebdddc549fb591d674bcdb4868940c7672
WORKDIR /app
COPY --from=bundle /bundle/supervisor.mjs /app/supervisor.mjs
ENV PILOT_RUNTIME=controller
ENTRYPOINT ["node","/app/supervisor.mjs"]
