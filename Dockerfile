# ---- build: install production dependencies from the lockfile ----
FROM node:26-alpine AS build
WORKDIR /app
COPY package*.json ./
# Production deps only — deterministic (from the lockfile) and no devDependencies
# (testcontainers & its transitive protobufjs/grpc/dockerode don't belong in the
# runtime image: smaller + smaller CVE surface).
RUN npm ci --omit=dev

# ---- prod: clean base, no npm, only installed deps + source ----
FROM node:26-alpine AS prod

# Links the ghcr package to this repo. Must be on the FINAL stage — labels set in an
# earlier stage are discarded.
LABEL org.opencontainers.image.source="https://github.com/junosuarez/ez12mqtt"
LABEL org.opencontainers.image.description="Polls APsystems EZ1 microinverters and publishes to MQTT"
LABEL org.opencontainers.image.licenses="ISC"
# The runtime only runs `node src/index.ts` (Node's native TS type-stripping); strip
# the npm CLI so its bundled transitive deps (undici, …) don't show up in image scans.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY src ./src

# Command to run the application (outbound only — no port exposed)
CMD ["node", "src/index.ts"]
