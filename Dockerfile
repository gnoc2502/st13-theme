# syntax=docker/dockerfile:1

# ---------- deps ----------
# bookworm-slim (glibc), not alpine: bcrypt / better-sqlite3 ship prebuilt
# binaries for glibc but not musl, so alpine would compile them from source.
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Toolchain lives in this stage only — it is the fallback path for any
# native dep whose prebuild is missing for this Node ABI.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Overridden by env_file/.env if that sets NODE_ENV. Production enables the
# Secure cookie flag — keep it that way once the service is behind HTTPS.
ENV NODE_ENV=production \
    PORT=8787

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server.js db.js r2.js cli.js ./
COPY public ./public
COPY scripts ./scripts

# Uploads are held in memory and PUT straight to R2 — the container writes
# nothing to disk, so it can run read-only as a non-root user.
USER node

EXPOSE 8787

# /health is public and does `SELECT 1`, so this covers "up AND can reach Postgres".
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
