# syntax=docker/dockerfile:1.7

# ==========================================
# Stage 1: Builder — 编译 Morphz + Executor 工作区
# ==========================================
FROM rust:1.91-bookworm AS builder

# 安装构建期系统依赖（SQLite、OpenSSL 等）
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制清单以利用 Docker 层缓存
COPY Cargo.toml Cargo.lock ./
COPY executor/Cargo.toml ./executor/
COPY morphz/Cargo.toml ./morphz/

# 预创建 dummy 源码以缓存依赖编译
RUN mkdir -p executor/src morphz/src && \
    echo "pub fn _noop() {}" > executor/src/lib.rs && \
    echo "fn main() {}" > morphz/src/main.rs

# 预编译依赖（此层在依赖未变时会被缓存）
RUN cargo build --release --package morphz || true

# 复制真实源码并编译
COPY executor/src ./executor/src
COPY morphz/src ./morphz/src
COPY models ./models

RUN touch executor/src/lib.rs morphz/src/main.rs && \
    cargo build --release --package morphz

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
COPY --from=builder /app/target/release/morphz /usr/local/bin/morphz

# 复制模型；Provider/凭证配置由 setup 写入宿主挂载的用户配置卷。
COPY --from=builder /app/models /home/morphz/models

# 数据目录（SQLite + LanceDB）
RUN mkdir -p /home/morphz/data /home/morphz/.config/morphz && chown -R morphz:morphz /home/morphz

USER morphz

ENV RUST_LOG=info,morphz=debug \
    MORPHZ_DB_PATH=/home/morphz/data/morphz.db \
    MORPHZ_BIND=0.0.0.0:8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD [ "curl", "-fsS", "http://127.0.0.1:8080/health" ]

ENTRYPOINT [ "morphz" ]
CMD [ "serve" ]
