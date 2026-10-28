FROM node:24-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine

RUN addgroup -S gateway && adduser -S gateway -G gateway

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY --from=build /app/dist ./dist

RUN chown -R gateway:gateway /app
USER gateway

ENV BIND_ADDRESS=0.0.0.0
EXPOSE 3022
CMD ["node", "dist/server.js"]
