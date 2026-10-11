FROM node:22-trixie-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p /data/image2 && chown -R node:node /data/image2
ENV NODE_ENV=production PORT=18088 HOSTNAME=0.0.0.0 IMAGE2_DATA_DIR=/data/image2
USER node
VOLUME ["/data/image2"]
EXPOSE 18088
HEALTHCHECK --interval=15s --timeout=5s CMD node -e "fetch('http://127.0.0.1:18088/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
