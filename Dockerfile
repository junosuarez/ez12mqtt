# ---- build: install production dependencies from the lockfile ----
# Floating tag on purpose: each rebuild picks up base-image security patches. A digest pin
# would freeze them until someone remembered to bump it.
FROM node:26-alpine AS build
WORKDIR /app
COPY package*.json ./
# Production deps only — deterministic (from the lockfile) and no devDependencies
# (testcontainers & its transitive protobufjs/grpc/dockerode don't belong in the
# runtime image: smaller + smaller CVE surface).
# --ignore-scripts: nothing gets to execute code at install time.
RUN npm ci --omit=dev --ignore-scripts

# ---- prod: clean base, no npm, only installed deps + source ----
FROM node:26-alpine AS prod

# Links the ghcr package to this repo. Must be on the FINAL stage — labels set in an
# earlier stage are discarded.
LABEL org.opencontainers.image.source="https://github.com/junosuarez/ez12mqtt"
LABEL org.opencontainers.image.description="Polls APsystems EZ1 microinverters and publishes to MQTT"
LABEL org.opencontainers.image.licenses="ISC"

ENV NODE_ENV=production

# The runtime only runs `node src/index.ts` (Node's native TS type-stripping); strip
# the npm CLI so its bundled transitive deps (undici, …) don't show up in image scans.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
# root-owned, node-readable: the app never writes to disk, so it has no business being
# able to modify its own code. Also works unchanged under a read-only root filesystem.
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root src ./src

# Outbound connections only by default; METRICS_PORT optionally binds one unprivileged port.
# Either way nothing needs privilege — which is also why that port must be above 1024.
USER node

CMD ["node", "src/index.ts"]
