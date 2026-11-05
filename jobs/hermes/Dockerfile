# A home with Hermes Agent and the charter CLI preinstalled read-only, and a default boot that runs them.
# Built from the repo root after `npm run build`: docker build -f jobs/hermes/Dockerfile -t charter-hermes .
# Image size:
ARG BASE=charter-home
FROM ${BASE}
ARG HERMES_VERSION=0.22.7
ARG HERMES_SHA256=91bf15f50ce61e7da8a7890c11b202b904c3d7c0e2688a6dc6bcb42a2fe8b91d
ARG PYTHON_VERSION=3.14.9
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ripgrep \
  && rm -rf /var/lib/apt/lists/*
# The tests, the docs site, the evals and the desktop app's sources are never read by the gateway.
# A .git entry and no install-stamp.json is a developer's checkout to Hermes: check_runtime and
# prepare_launch in hermes_cli/venv_sync.py skip it, so its package manager never re-syncs the tree
# or downloads 570 MB of tool bundles at launch.
RUN set -eu; mkdir -p /opt/hermes/app; \
  curl -fsSLo /tmp/hermes.tar.gz "https://github.com/NousResearch/hermes-agent/archive/refs/tags/v${HERMES_VERSION}.tar.gz"; \
  echo "${HERMES_SHA256}  /tmp/hermes.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/hermes.tar.gz -C /opt/hermes/app --strip-components=1 --no-same-owner; \
  rm -f /tmp/hermes.tar.gz; \
  cd /opt/hermes/app; \
  rm -rf tests tests-js website evals apps install-stamp.json; \
  git init -q
# Hermes's own CPython, under /opt so the venv never points into a home. Downloads are off for the sync,
# so it uses this interpreter and fetches no second one. Compiled now: the root is read-only at runtime.
RUN set -eu; \
  export UV_CACHE_DIR=/tmp/uv-cache UV_PYTHON_INSTALL_DIR=/opt/hermes/python UV_PYTHON_BIN_DIR=/tmp/uv-bin; \
  uv python install "${PYTHON_VERSION}"; \
  cd /opt/hermes/app; \
  UV_PROJECT_ENVIRONMENT=/opt/hermes/venv UV_PYTHON_DOWNLOADS=never uv sync --locked --no-default-groups \
    --python "${PYTHON_VERSION}" --extra telegram --extra discord --extra google --extra mcp --extra web; \
  case "$(readlink -f /opt/hermes/venv/bin/python)" in \
    /opt/hermes/python/*) ;; \
    *) echo "venv python resolves outside /opt/hermes/python" >&2; exit 1 ;; \
  esac; \
  /opt/hermes/venv/bin/python -m compileall -q /opt/hermes/app /opt/hermes/venv; \
  rm -rf /tmp/uv-cache /tmp/uv-bin; \
  ln -s /opt/hermes/venv/bin/hermes /usr/local/bin/hermes
COPY package.json package-lock.json /opt/charter/
RUN set -eu; cd /opt/charter; \
  npm_config_cache=/tmp/npm-cache npm ci --omit=dev; \
  rm -rf /tmp/npm-cache; \
  printf '#!/bin/sh\nexec node /opt/charter/dist/cli.js "$@"\n' > /usr/local/bin/charter; \
  chmod 755 /usr/local/bin/charter
COPY dist /opt/charter/dist
RUN test -f /opt/charter/dist/cli.js || { echo 'run npm run build first' >&2; exit 1; }
COPY jobs/hermes/hermes-home.sh jobs/hermes/boot-default.sh /app/
RUN chmod 755 /app/hermes-home.sh /app/boot-default.sh
# The image's facts, not the tenant's: a config.yaml on the disk cannot turn lazy installs back on.
ENV HERMES_DISABLE_LAZY_INSTALLS=1 HERMES_HOME=/home/tenant/.hermes
USER tenant
CMD ["/app/hermes-home.sh"]
