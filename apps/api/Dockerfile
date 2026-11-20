# syntax=docker/dockerfile:1
# Production image for the NestJS API (apps/api).
# Build from this directory:
#   docker build -t winger-api .
# Or from the repo root:
#   docker build -t winger-api -f apps/api/Dockerfile apps/api

# ----- build -----
FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src

# schema.prisma reads DATABASE_URL during generate. This value is
# process-scoped to that command: it is not an image ENV and is not
# copied into the runtime stage.
RUN DATABASE_URL="postgresql://placeholder:placeholder@prisma-generate.invalid:5432/placeholder" \
  npx prisma generate \
  && npm run build \
  && npm prune --omit=dev

# ----- runtime -----
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 winger \
  && useradd --system --uid 10001 --gid winger --home-dir /app --shell /usr/sbin/nologin winger

COPY --from=build --chown=winger:winger /app/package.json /app/package-lock.json ./
COPY --from=build --chown=winger:winger /app/node_modules ./node_modules
COPY --from=build --chown=winger:winger /app/dist ./dist
COPY --from=build --chown=winger:winger /app/prisma ./prisma

USER winger

EXPOSE 3000

CMD ["node", "dist/main.js"]
