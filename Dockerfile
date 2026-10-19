FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-impress libreoffice-writer libreoffice-calc \
        fonts-liberation fonts-dejavu-core fonts-noto-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

RUN useradd -m -u 10001 viewer && mkdir -p /data/cache && chown -R viewer /data
USER viewer

ENV PORT=8080 CACHE_DIR=/data/cache HOME=/home/viewer
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
