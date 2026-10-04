# Single process, zero dependencies. Mount a volume at /data for the database.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production \
    DATABASE_PATH=/data/freeheld.db \
    PORT=3000
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
