# VISION STREAM room service + SFU + web client in one image.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY app/package.json app/
COPY e2e/package.json e2e/
RUN npm ci
COPY shared shared
COPY server server
COPY app app
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data WEB_DIR=/app/web PORT=8080
WORKDIR /app
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/server/package.json server/
COPY --from=build /src/app/package.json app/
COPY --from=build /src/e2e/package.json e2e/
# Production dependencies of the server only (mediasoup downloads its prebuilt worker here).
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/app/dist web
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080 40000-40003/udp 40000-40003/tcp
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
