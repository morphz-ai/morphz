# syntax=docker/dockerfile:1.7

FROM rust:1.97.1-bullseye@sha256:02d78ca3f928195c2a907543de778adfd728ad7e2a24fdc6aef582b7c77842e0 AS builder
WORKDIR /src
ARG RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu
ARG MORPHZ_BUILD_GIT_COMMIT
ARG MORPHZ_CARGO_FEATURES=""
# Morphz intentionally puts the newer hotbundle SQLite archive before SQLx's
# bundled archive. Rust's x86_64 self-contained LLD rejects those duplicate
# symbols unless the same first-definition-wins policy is made explicit.
ENV RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN} \
    OPENSSL_STATIC=1 \
    OPENSSL_INCLUDE_DIR=/usr/include \
    CARGO_TARGET_DIR=/src/target-static \
    RUSTFLAGS="-C link-arg=-Wl,--allow-multiple-definition"
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target-static \
    test -n "$MORPHZ_BUILD_GIT_COMMIT" \
    && export OPENSSL_LIB_DIR="/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)" \
    && if [ -n "$MORPHZ_CARGO_FEATURES" ]; then \
         cargo build --locked --release -p morphz --bin morphz --features "$MORPHZ_CARGO_FEATURES"; \
       else \
         cargo build --locked --release -p morphz --bin morphz; \
       fi \
    && ! ldd /src/target-static/release/morphz | grep -E 'libssl|libcrypto' \
    && cc -O2 -Wall -Wextra -Werror \
        /src/benchmarks/harbor/harbor_wait.c \
        "$OPENSSL_LIB_DIR/libsqlite3.a" -ldl -lpthread -lm \
        -o /src/target-static/release/morphz-harbor-wait \
    && ! ldd /src/target-static/release/morphz-harbor-wait | grep sqlite \
    && mkdir -p /out \
    && cp /src/target-static/release/morphz /out/morphz \
    && cp /src/target-static/release/morphz-harbor-wait /out/morphz-harbor-wait

FROM scratch AS export
COPY --from=builder /out/morphz /morphz
COPY --from=builder /out/morphz-harbor-wait /morphz-harbor-wait
