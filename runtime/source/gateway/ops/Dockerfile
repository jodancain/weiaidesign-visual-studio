FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pil fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
# Bake the gateway script into the image so the deployed revision is a versioned
# artifact that survives container recreation. This is the root-cause fix for the
# Jun-23/Jul-12 drift, and avoids WSL bind mounts (unreliable on this host).
COPY node-gateway.mjs /node-gateway.mjs
COPY studio /studio
ENV STUDIO_DATA_DIR=/data/studio
VOLUME ["/data/studio"]
# Only openai_model_name is actually consumed; the retired api.yundongyl.cn base_url
# and its stale key are deliberately left out (see config.toml comments).
COPY config.toml /config.toml
CMD ["node", "/node-gateway.mjs"]
