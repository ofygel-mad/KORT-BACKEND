FROM node:20-alpine
WORKDIR /app

# Avoid Corepack network fetch flakiness in CI/build by installing pnpm directly.
RUN npm install -g pnpm@10.13.1

# Install deps (frozen lockfile — reproducible)
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# Copy source and compile TypeScript → dist/
COPY . .
RUN pnpm build

ENV NODE_ENV=production
EXPOSE 8000

# On start: migrate DB, seed demo data (idempotent via upsert), then run server
CMD ["pnpm", "run", "start:docker"]
