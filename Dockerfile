# jobhunt-mcp, HTTP mode (src/http.ts). Two stages: build with dev dependencies, then
# run with production dependencies only. No secrets in here: they come from env vars
# at runtime (Render's Environment tab, or `docker run --env-file .env`).

# ---------- build: compile TypeScript ----------
FROM node:24-slim AS build
WORKDIR /app
# Copy the manifests first: this layer (and npm ci) is cached until dependencies change.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- run ----------
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Supabase's CA certificate: the pool verifies the database server with it.
COPY certs ./certs
# Don't run as root: the official image ships an unprivileged "node" user.
USER node
# Documentation only; Render tells the app which port to use through $PORT.
EXPOSE 3000
CMD ["node", "dist/http.js"]
