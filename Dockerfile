FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY --from=builder /app/dist ./dist
COPY src/db/schema.sql ./dist/db/schema.sql

VOLUME /data
ENV DB_PATH=/data/pr-triage.db

ENTRYPOINT ["node", "dist/cli.js"]
