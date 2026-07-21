FROM rust:1.91-bookworm

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       bash ca-certificates curl git python3 sqlite3 procps \
    && rm -rf /var/lib/apt/lists/*

# Cache the dependency families the task permits so the project itself can be
# built with --offline while the agent phase retains Provider connectivity.
COPY Cargo.toml /opt/forgedepot-cache/Cargo.toml
RUN mkdir -p /opt/forgedepot-cache/src \
    && printf 'fn main() {}\n' > /opt/forgedepot-cache/src/main.rs \
    && cd /opt/forgedepot-cache \
    && cargo fetch \
    && rm -rf /opt/forgedepot-cache

RUN useradd --create-home --uid 1000 agent \
    && mkdir -p /app \
    && chown -R agent:agent /app

WORKDIR /app
