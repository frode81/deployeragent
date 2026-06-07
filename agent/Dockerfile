FROM node:22-alpine AS builder

RUN apk add --no-cache git python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────
FROM node:22-slim

# System deps + pg_dump som matcher postgres:17 på nettverket (Debian sin klient er eldre)
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends curl ca-certificates; \
  install -m 0755 -d /etc/apt/keyrings; \
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /etc/apt/keyrings/postgresql.asc; \
  chmod 644 /etc/apt/keyrings/postgresql.asc; \
  . /etc/os-release; \
  echo "deb [signed-by=/etc/apt/keyrings/postgresql.asc] http://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    docker.io \
    postgresql-client-17 \
  ; \
  apt-get autoremove -y; \
  rm -rf /var/lib/apt/lists/*

# Install nixpacks v1.41.0 — statisk musl-binær (ingen libc-avhengigheter)
RUN curl -fsSL \
      "https://github.com/railwayapp/nixpacks/releases/download/v1.41.0/nixpacks-v1.41.0-x86_64-unknown-linux-musl.tar.gz" \
      | tar -xz -C /usr/local/bin nixpacks \
    && chmod +x /usr/local/bin/nixpacks \
    && nixpacks --version

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN mkdir -p /tmp/builds /data/deployments

ENV PORT=2080
ENV WORK_DIR=/tmp/builds
ENV DATA_DIR=/data/deployments

EXPOSE 2080

CMD ["node", "dist/index.js"]
