# EgressView Hub — supported production image (P2-90).
#
# Dockerfile.demo is not this: it ships a synthetic database and runs
# write-protected. This one carries no data and expects a mounted volume.
#
# Build:  docker build -t egressview .
# Run:    docker run -d --restart=on-failure:10 --init \
#           -p 3000:3000 -v egressview-data:/data --env-file .env egressview
#
# `--restart` is not optional. The Hub runs an event-loop watchdog that sends
# the process an unblockable SIGKILL when the main thread stops answering, on
# the reasoning that a fast restart beats a hang that looks like an outage.
# Without a restart policy the container simply exits and the reasoning fails.
# `--init` gives the container a real PID 1, so signals and reaping behave.

FROM node:22-bookworm-slim

RUN groupadd --system egressview && \
    useradd --system --gid egressview --create-home egressview

WORKDIR /app

# .npmrc has to come along: it sets ignore-scripts, without which npm treats
# better-sqlite3's bundled binding.gyp as an implicit `node-gyp rebuild` and
# compiles SQLite from source. This image has no toolchain, and installing one
# would be the wrong fix -- the package already ships a prebuilt binary.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js mcp-server.js ./
COPY src/ ./src/
COPY public/ ./public/
COPY .env.example ./

# State lives on a volume, never in the image layer. An image that could hold
# the database would carry one machine's traffic record into every copy of it.
ENV NODE_ENV=production \
    PORT=3000 \
    EGRESSVIEW_DB_PATH=/data/egressview.db \
    EGRESSVIEW_BACKUP_DIR=/data/backups \
    EGRESSVIEW_CONFIG_PATH=/data/config.json
RUN mkdir -p /data/backups && chown -R egressview:egressview /app /data
VOLUME ["/data"]

USER egressview
EXPOSE 3000

# /readyz rather than /healthz: readiness reports whether the database and
# migrations are actually usable, which is what a supervisor should act on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/readyz').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
