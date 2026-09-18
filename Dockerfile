FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:docker

FROM node:24-slim
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/boardless.sqlite PUBLIC_DIR=/app/dist/client MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
RUN mkdir -p /data
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "dist/node/server.js"]
