# syntax=docker/dockerfile:1

# Node 24: `node:sqlite` is a built-in there, which is why the app has no
# database driver dependency at all.

# --- manifests -------------------------------------------------------------
#
# Reduces the tree to just the package.json files so the dependency install
# layer is not invalidated by a source edit.
#
# Derived with `find` rather than a hand-written COPY list per package. The
# hand-written version silently broke the build twice: adding @storeagent/billing
# and @storeagent/resilience left them out, and `npm ci` cannot resolve a
# workspace whose manifest is missing. A list that must be updated by hand is a
# list that will be forgotten.
FROM node:24-slim AS manifests
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages packages
RUN find packages -mindepth 2 -maxdepth 2 ! -name package.json -exec rm -rf {} +

# --- build -----------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /app

COPY --from=manifests /src/ ./
RUN npm ci

# tsconfig.base.json is required: every package extends it, so omitting it
# fails the build with a confusing "file not found" from tsc.
COPY tsconfig.json tsconfig.base.json ./
COPY packages packages
RUN npm run build

# Fail loudly here rather than at container start, where the only symptom is a
# 503 from the proxy and an empty log.
RUN test -f packages/gateway/dist/src/main.js \
 && test -f packages/gateway/public/widget.js

# --- runtime ---------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Drop root before running application code.
RUN useradd --system --uid 10001 --create-home storeagent

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages packages
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/gateway/dist/src/main.js"]
