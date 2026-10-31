# Game server + the four Relay agents in one long-running container (Railway, Fly, Render, ...).
# Build context: backend/server. Configuration comes from env vars; see DEPLOY.md.
FROM oven/bun:1.4.4-slim

WORKDIR /app
RUN bun install --global terse-cli@0.14.9
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .

ENV NODE_ENV=production
EXPOSE 3001
CMD ["sh", "scripts/start-production.sh"]
