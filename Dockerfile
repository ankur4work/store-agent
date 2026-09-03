# syntax=docker/dockerfile:1

# Node 24: `node:sqlite` is a built-in there, which is why the app has no
# database driver dependency at all.
FROM node:24-slim AS build
WORKDIR /app

# Install against the lockfile first so dependency layers survive source edits.
COPY package.json package-lock.json ./
COPY packages/attribution/package.json   packages/attribution/
COPY packages/eval/package.json          packages/eval/
COPY packages/gateway/package.json       packages/gateway/
COPY packages/grounding/package.json     packages/grounding/
COPY packages/orchestrator/package.json  packages/orchestrator/
COPY packages/ucp-client/package.json    packages/ucp-client/
COPY packages/voice/package.json         packages/voice/
RUN npm ci

COPY tsconfig.json ./
COPY packages/ packages/
RUN npm run build

# --- runtime ---------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Drop root before running application code.
RUN useradd --system --uid 10001 --create-home storeagent

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/ packages/
RUN npm ci --omit=dev && npm cache clean --force

# The volume mount point. Without a volume mounted here the database is
# ephemeral and every merchant is logged out on the next deploy, so
# STOREAGENT_DB is deliberately not defaulted to a path outside it.
RUN mkdir -p /data && chown storeagent:storeagent /data
VOLUME ["/data"]
ENV STOREAGENT_DB=/data/storeagent.db

USER storeagent
EXPOSE 8787

# Uses the app's own health endpoint rather than a bare TCP check, so a
# process that is listening but broken is reported unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/gateway/dist/src/main.js"]
