FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS validate
COPY . .
RUN npm run lint && npm run typecheck && npm test && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=validate /app/dist ./dist
# Drizzle reads SQL and journal files at runtime; tsc does not compile them.
# Keep the migration source in the runtime image independently of build assets.
COPY --from=validate /app/src/db/migrations ./src/db/migrations
USER node
CMD ["node", "dist/index.js"]
