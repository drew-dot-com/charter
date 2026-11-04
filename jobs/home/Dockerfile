# A tenant's home: sshd as the unprivileged tenant on the tenant's own disk, with Node, Python, uv and git.
# Image size: 709 MB on arm64 (docker image ls, 2026-11-04).
FROM debian:bookworm-slim
ARG TARGETARCH
ARG NODE_VERSION=22.23.4
ARG UV_VERSION=0.13.7
# No setuid path out of tenant, and no package host keys: the real one is generated on the disk.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    openssh-server openssh-client python3 python3-venv python3-pip git curl jq rsync tmux ca-certificates procps xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
  && rm -f /etc/ssh/ssh_host_*
# The legacy builder leaves TARGETARCH empty: fall back to the build machine's own arch.
RUN set -eu; arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
  case "$arch" in \
    arm64) node=arm64; node_sha=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b; \
           uv=aarch64; uv_sha=71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc ;; \
    amd64) node=x64; node_sha=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce; \
           uv=x86_64; uv_sha=c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83 ;; \
    *) echo "unsupported arch $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node}.tar.xz"; \
  echo "$node_sha  /tmp/node.tar.xz" | sha256sum -c -; \
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
  curl -fsSLo /tmp/uv.tar.gz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv}-unknown-linux-gnu.tar.gz"; \
  echo "$uv_sha  /tmp/uv.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 --no-same-owner; \
  rm -f /tmp/node.tar.xz /tmp/uv.tar.gz; \
  node --version; uv --version
# A '*' password is not locked: pubkey login must not hinge on a shadow file sshd cannot read.
RUN useradd -p '*' --uid 10001 --create-home --shell /bin/bash tenant
COPY home.sh sshd_config /app/
ENV HOME=/home/tenant
USER tenant
CMD ["/app/home.sh"]
