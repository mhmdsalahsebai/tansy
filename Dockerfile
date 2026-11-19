FROM node:24-slim AS build
WORKDIR /app
# better-sqlite3 compiles from source when there's no prebuilt binary for this Node. The final image has no compiler.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates && rm -rf /var/lib/apt/lists/*
# Everything at once, because `npm ci` needs every workspace's package.json.
COPY . .
RUN npm ci
# Only so the build can load modules that read it. Nothing connects at build time.
ENV DATABASE_URL=file:/tmp/build.db
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Separate from the build stage, so an image with extra plugins can start from that one with its dev tools intact. See docs/EXTENDING.md.
FROM build AS pruned
RUN npm prune --omit=dev

FROM node:24-slim
WORKDIR /app/apps/starter
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8090
ENV HOSTNAME=0.0.0.0
# Prisma's migration engine needs OpenSSL, and picks its binary by the version it finds.
# Backups of a Postgres database need pg_dump, pg_restore and psql of at least the server's major version.
# Set TANSY_PG_BIN for another version, or install it in an image built on this one.
RUN apt-get update && apt-get install -y --no-install-recommends openssl postgresql-client && rm -rf /var/lib/apt/lists/*
COPY --from=pruned /app/node_modules /app/node_modules
COPY --from=pruned /app/packages/cms /app/packages/cms
COPY --from=pruned /app/plugins /app/plugins
COPY --from=pruned /app/themes /app/themes
COPY --from=pruned /app/examples /app/examples
COPY --from=build /app/apps/starter/.next/standalone /app
COPY --from=build /app/apps/starter/.next/static /app/apps/starter/.next/static
COPY --from=build /app/apps/starter/public /app/apps/starter/public
# For the tansy command: tansy backup and tansy restore read storage and backup settings from it.
COPY --from=build /app/apps/starter/tansy.config.ts /app/apps/starter/tsconfig.json /app/apps/starter/
COPY docker/entrypoint.sh /usr/local/bin/tansy-entrypoint
RUN chmod 755 /usr/local/bin/tansy-entrypoint && mkdir -p /data && chown node:node /data /app /app/apps/starter
USER node
VOLUME /data
EXPOSE 8090
ENTRYPOINT ["tansy-entrypoint"]
CMD ["node", "server.js"]
