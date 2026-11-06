FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev && mkdir -p runs && chown node:node runs
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["npx", "tsx", "src/server/index.ts"]
