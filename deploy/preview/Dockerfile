FROM node:22-bookworm-slim
WORKDIR /app
COPY app/package.json app/package-lock.json ./
COPY app/vendor/ ./vendor/
RUN npm ci --no-audit --no-fund && chown -R node:node /app
USER node
# Source is mounted read-only by Compose, not baked into an outdated build.
CMD ["node", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--strictPort"]
