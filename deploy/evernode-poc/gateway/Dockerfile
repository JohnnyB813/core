FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
RUN apk add --no-cache haproxy=3.4.7-r0 lua5.4-libs=5.4.8-r0 pcre2=10.49-r0 && node --version && haproxy -v
WORKDIR /app
COPY package.json package-lock.json ./
COPY deploy/patch-hotpocket.cjs ./deploy/patch-hotpocket.cjs
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && node deploy/patch-hotpocket.cjs
COPY shared ./shared
COPY controller/registry.ts ./controller/registry.ts
COPY gateway/*.ts gateway/*.json ./gateway/
RUN mkdir -p /run/poc && chown node:node /run/poc
USER root
EXPOSE 8080 8443
CMD ["node", "gateway/bootstrap.ts"]
