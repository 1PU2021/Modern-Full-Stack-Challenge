FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
COPY eslint.config.js ./.env.example ./

CMD ["npm", "run", "intake"]
