# Multi-stage build keeps the runtime image small.

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

# Railway injects PORT; we read it via env in src/config.ts.
EXPOSE 8080
CMD ["node", "dist/index.js"]
