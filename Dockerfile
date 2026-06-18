# syntax=docker/dockerfile:1
#
# Baton — all-in-one runtime image.
#
# Bundles the three toolchains Baton needs so the *full* path runs anywhere:
#   - Node 22        — Flue runtime + the compiler/executor (workerd transitive deps need >=22)
#   - Python + processpiper — the primary BPMN/PNG renderer
#   - Graphviz       — the graceful-degradation structural fallback renderer
#
# Default action: `npm run onboard:demo` — the zero-infra four-lane happy path
# from the README, so `docker run baton` reproduces the demo with nothing else.
#
# Build:  docker build -t baton .
# Run:    docker run --rm baton                      # the demo (writes employees/EMP-*.json)
# Dev:    docker run --rm -it baton bash             # shell into the full toolchain (as the `node` user)
# AI:     docker run --rm -e VLLM_BASE_URL=http://host.docker.internal:8000/v1 baton npm run run:design -- --payload '{"prompt":"..."}'

# Debian slim, not Alpine: Flue pulls Cloudflare's workerd, whose musl/Alpine
# story is fragile (and we already nurse an aarch64 workerd issue). apt gives us
# python3 + graphviz in one clean layer. The slim variant keeps it lean.
FROM node:22-bookworm-slim

# Render toolchain + git (skills resolver) + certs. One layer, cleaned after.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      graphviz \
      git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- deps before source: package-lock changes far less often than src/,
# so this layer is reused across most builds (the #1 Docker hygiene signal). ----
COPY package.json package-lock.json ./
# npm install (not ci): the lock is generated on the build host's arch, and the
# Flue -> Cloudflare workerd platform optional deps don't reconcile under a
# strict clean install. install reconciles them per-platform (same reason CI
# uses install rather than ci).
RUN npm install

# processpiper into an isolated venv — don't pollute the Debian system
# site-packages (and avoid the PEP-668 "externally-managed" breakage).
# PYTHON is what src/actions/render.ts reads to pick the interpreter.
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip processpiper
ENV PYTHON=/opt/venv/bin/python
ENV PATH=/opt/venv/bin:$PATH

# Non-root runtime: the official node image already ships a `node` user
# (UID 1000) — reuse it rather than adding another. Baton writes employees/
# and telemetry/ at runtime; running non-root keeps generated artifacts from
# being root-owned on bind mounts.
COPY --chown=node:node . .

# Create the runtime-writeable dirs (employees/ and telemetry/ are in
# .dockerignore, so they arrive empty). chown ONLY these — copying the whole
# /app tree into a new layer just to change ownership would nearly double the
# image (node_modules is ~1GB); --chown above already owns the source for free.
RUN mkdir -p employees diagrams telemetry && chown -R node:node employees diagrams telemetry

USER node

# The optional HTTP surface (src/app.ts — Hono + /metrics + Flue routes) is
# served via `npm run build && npm start`. Default CMD is the demo, not the
# server, so nothing listens here unless you start the server.
EXPOSE 3000

CMD ["npm", "run", "onboard:demo"]
