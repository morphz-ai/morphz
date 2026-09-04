# syntax=docker/dockerfile:1.7

# ==========================================
# Stage 1: Builder — 编译 Morphz + Executor 工作区
# ==========================================
FROM rust:1.97.1-bookworm AS builder

# 安装构建期系统依赖（SQLite、OpenSSL 等）
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace members evolve together. Copying only selected manifests makes the
# Docker build silently lag behind Cargo.toml as soon as another crate joins the
# workspace. Build the same checked-out workspace CI sees, while BuildKit cache
# mounts retain registry and target artifacts across local/Cloudflare builds.
COPY . .

# Morphz intentionally puts the current libsqlite3-hotbundle ahead of SQLx's
# older bundled amalgamation. GNU ld rejects the duplicate SQLite symbols by
# default, unlike the native development linker, so permit the documented
# first-definition-wins linkage for the Linux release image.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    RUSTFLAGS="-C link-arg=-Wl,--allow-multiple-definition" \
    cargo build --release --package morphz && \
    mkdir -p /app/dist && \
    cp /app/target/release/morphz /app/dist/morphz

# ==========================================
# Stage 2: Runtime — 最小化运行时镜像
# ==========================================
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 创建非 root 用户
RUN useradd -r -u 1000 -m -d /home/morphz morphz

WORKDIR /home/morphz

# 从 builder 复制编译产物
COPY --from=builder /app/dist/morphz /usr/local/bin/morphz

# 复制模型；Provider/凭证配置由 setup 写入宿主挂载的用户配置卷。
COPY --from=builder /app/models /home/morphz/models

# 数据目录（SQLite + LanceDB）
RUN mkdir -p /home/morphz/data /home/morphz/.config/morphz && chown -R morphz:morphz /home/morphz

USER morphz

ENV RUST_LOG=info,morphz=debug \
    MORPHZ_STORAGE_SQLITE_PATH=/home/morphz/data/morphz.db \
    MORPHZ_BIND=0.0.0.0:18804

EXPOSE 18804

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD [ "curl", "-fsS", "http://127.0.0.1:18804/health" ]

ENTRYPOINT [ "morphz" ]
CMD [ "serve" ]
