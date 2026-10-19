# Ретранслятор DotLink: docker build -f deploy/relay/Dockerfile -t dotlink-relay .
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release -p dotlink-relay

FROM debian:bookworm-slim
RUN useradd --system --no-create-home relay
COPY --from=build /src/target/release/dotlink-relay /usr/local/bin/dotlink-relay
USER relay
EXPOSE 47900
ENV DOTLINK_RELAY_LISTEN=0.0.0.0:47900 RUST_LOG=info
HEALTHCHECK --interval=30s --timeout=3s CMD ["/bin/sh", "-c", "exec 3<>/dev/tcp/127.0.0.1/47900 && printf 'GET /healthz HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q ok <&3"]
ENTRYPOINT ["dotlink-relay"]
