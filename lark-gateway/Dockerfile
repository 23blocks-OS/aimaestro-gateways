FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
ARG GATEWAY_UID=1000
ARG GATEWAY_GID=1000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY routing.example.yaml ./routing.example.yaml
RUN mkdir -p /app/data /home/gateway/.agent-messaging && chown -R "$GATEWAY_UID:$GATEWAY_GID" /app /home/gateway
USER ${GATEWAY_UID}:${GATEWAY_GID}
ENV HOME=/home/gateway BIND_ADDRESS=0.0.0.0
EXPOSE 3025
CMD ["node", "dist/server.js"]
