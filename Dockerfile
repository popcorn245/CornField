# cornfield: the always-on dashboard, as one small image. No build step: the modules run as written.
#
#   docker build -t cornfield .
#   docker run --rm --network host -v "$PWD:/repo:ro" -v cornfield-data:/data cornfield
#
# The repo to map is mounted at /repo (read-only is enough); cornfield's own state (cornfield.db, the SQLite
# file) lives in /data, a volume owned by the image's non-root user `node`. The image listens on 127.0.0.1 by
# default, which is the container's own loopback: for a hosted cornfield set CORNFIELD_HOST=0.0.0.0 together with
# forge sign-in and an https CORNFIELD_PUBLIC_URL (the server refuses anything else at startup), give it the
# secrets through the environment when it starts (never in the image), and put a reverse proxy in front.
# See compose.example.yml and docs/deploy.md.
FROM node:22-alpine

ENV NODE_ENV=production \
    CORNFIELD_PORT=3350 \
    CORNFIELD_HOST=127.0.0.1 \
    CORNFIELD_DATA=/data

WORKDIR /opt/cornfield
COPY package.json package-lock.json ./
# Runtime needs nothing but Node; js-yaml is the one optional dependency (the cloud deriver reads CI workflows with it)
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY cli ./cli
COPY core ./core
COPY explorer ./explorer
COPY plugins ./plugins
COPY server ./server
COPY LICENSE README.md CHANGELOG.md ./

# /data is the volume's first content, so a new named volume is created owned by node (cornfield keeps the folder 0700 and cornfield.db 0600)
RUN mkdir -p /data /repo && chown node:node /data && chmod 700 /data
USER node
WORKDIR /repo
VOLUME ["/data"]
EXPOSE 3350

# /healthz answers without a session (every other route is 401 with sign-in)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.CORNFIELD_PORT || 3350) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "/opt/cornfield/cli/cornfield.js"]
CMD ["serve", "--repo", "/repo"]
