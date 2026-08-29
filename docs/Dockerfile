# PacketBench documentation site — a static container.
#
# Deployed to Railway as its own service, separate from the desktop app. The
# app is not a server and is never containerised; this image only carries the
# public site under `docs/`.
#
# The site is REBUILT here rather than shipping the committed HTML, so a deploy
# can never serve output that has drifted from `docs/src/*.md`. Build context is
# the repository root:
#
#   docker build -f docs/Dockerfile -t packetbench-docs .

# ---------------------------------------------------------------- build stage
FROM node:24-alpine AS build
WORKDIR /build

# `marked` is the only dependency the docs generator needs. Installing it alone
# keeps this stage seconds long instead of pulling the app's full toolchain
# (Tauri, React, Vite) that has nothing to do with rendering Markdown. Pinned to
# the same major the repo's devDependency declares.
RUN npm install --no-audit --no-fund marked@^18.0.11

COPY scripts/build-docs.mjs ./scripts/build-docs.mjs
COPY docs/ ./docs/

# Fail the build if a page declared in nav.json has no Markdown, so a broken
# nav reaches us here rather than as a 404 in production.
RUN node scripts/build-docs.mjs 2>&1 | tee /tmp/docs-build.log \
    && ! grep -q "have no Markdown yet" /tmp/docs-build.log

# ---------------------------------------------------------------- serve stage
FROM caddy:2-alpine AS serve

# Caddy reads {$PORT} at startup, which is how Railway assigns a port.
COPY docs/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /build/docs/ /srv/

# Drop privileges: nothing here needs root, and the content is read-only.
RUN addgroup -S site && adduser -S -G site site \
    && chown -R site:site /srv /config /data
USER site

EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
