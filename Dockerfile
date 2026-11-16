# Cursed Poker, as one process on one port: the built client and the socket
# from the same origin. See "Deploying" in README.md.

# --- build the client -------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build

# --- run the server ---------------------------------------------------------
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.base.json tsconfig.json ./
COPY shared shared
COPY server server
COPY --from=build /app/client/dist client/dist

# Not root: the only thing this process reads off the disk is client/dist.
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Node directly rather than through npm, so a stop signal reaches the server
# and it can close its tables properly. SESSION_SECRET must be set.
WORKDIR /app/server
CMD ["node", "--import", "tsx", "src/main.ts", "--production"]
