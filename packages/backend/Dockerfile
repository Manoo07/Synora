# Build and runtime are separate stages so the shipped image carries no
# compiler, no dev dependencies and no source - just what it runs.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Migrations are applied by `npm run db:migrate` from a checkout, not on
# boot: a container restarting under a load balancer would otherwise race
# several copies of itself through the same schema change.
COPY drizzle ./drizzle

# Never root. The process only needs to listen and talk out.
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
