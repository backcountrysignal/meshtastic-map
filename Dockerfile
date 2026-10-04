FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache git openssl ca-certificates

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# Meshtastic protobuf definitions are GPL-3.0 licensed.
# Pin the production collector to the v2.8.0 release.
RUN git clone --depth 1 --branch v2.8.0 https://github.com/meshtastic/protobufs.git /opt/protobufs

RUN chmod +x /app/docker/start.sh

ENV NODE_ENV=production
ENV PORT=8080
ENV MESH_DB_HOST=http://gcm-db

EXPOSE 8080

CMD ["/app/docker/start.sh"]
