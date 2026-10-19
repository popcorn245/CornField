# cornfield: the always-on dashboard, as one small image. No build step: the modules run as written.
#
#   docker build -t cornfield .
#   docker run --rm --network host -v "$PWD:/repo:ro" -v cornfield-data:/data cornfield
#
# The repo to map is mounted at /repo (read-only is enough), cornfield's own state (reviews, the SQLite file of
# sessions) lives in /data. Without sign-in, cornfield only listens on 127.0.0.1, so the image is run with host
# networking and reached from the machine itself (or over an SSH tunnel). With forge sign-in configured (the OAuth
# pair and CORNFIELD_SESSION_SECRET in env, an https CORNFIELD_PUBLIC_URL) it may listen on 0.0.0.0 behind a
# reverse proxy: docs/sign-in.md. The health check asks /healthz, which answers without a session.
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

RUN mkdir -p /data /repo && chown node:node /data
USER node
WORKDIR /repo
VOLUME ["/data"]
EXPOSE 3350

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.CORNFIELD_PORT || 3350) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "/opt/cornfield/cli/cornfield.js"]
CMD ["serve", "--repo", "/repo"]
