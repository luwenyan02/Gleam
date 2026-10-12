FROM node:22-bookworm-slim
WORKDIR /app
COPY app/package.json app/package-lock.json ./
COPY app/vendor/ ./vendor/
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --ignore-scripts --no-audit --no-fund && chown -R node:node /app
USER node
# Source is mounted read-only by Compose, not baked into an outdated build.
CMD ["node", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--strictPort"]
