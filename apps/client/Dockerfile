# This Dockerfile is designed to work with the turbo-pruned buildroot
# The build context should be the buildroot directory created by Cloud Build

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy the built application
# The buildroot already contains the built Next.js app
# COPY --chown=nextjs:nodejs apps/client/public ./public
COPY --chown=nextjs:nodejs apps/client/.next/standalone ./
COPY --chown=nextjs:nodejs apps/client/.next/static ./apps/client/.next/static

USER nextjs

EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

CMD ["node", "apps/client/server.js"]
