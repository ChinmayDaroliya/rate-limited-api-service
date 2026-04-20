# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first (Docker caches this layer if they don't change)
COPY package*.json ./
RUN npm ci --only=production

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS production

# Security: don't run as root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only what we need
COPY --from=builder /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./

# Own files as our non-root user
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Use node directly (not npm start) so SIGTERM reaches process
CMD ["node", "src/app.js"]
