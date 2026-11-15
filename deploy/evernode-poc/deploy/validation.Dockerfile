FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY shared ./shared
COPY controller ./controller
COPY gateway ./gateway
COPY client ./client
COPY reporter ./reporter
COPY tests ./tests
COPY tsconfig.json ./
COPY deploy/patch-hotpocket.cjs deploy/pilot-identity.json ./deploy/
RUN node deploy/patch-hotpocket.cjs
RUN --network=none npm run check
RUN --network=none npm test
RUN --network=none npm run build:controller
