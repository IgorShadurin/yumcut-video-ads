FROM node:22-alpine AS builder

WORKDIR /app

# Install the library toolchain first so source-only changes keep the dependency layer.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsup.config.ts vitest.config.ts ./
COPY scripts ./scripts
COPY src ./src
COPY README.md MEDIA_LICENSES.md LICENSE THIRD_PARTY_NOTICES.md ./
RUN npm run build

# Every demo deliberately installs the repository through its file dependency. This
# exercises the same packaged entry points a consumer receives, while keeping the
# image build deterministic and independent from GitHub availability.
COPY demos ./demos
RUN npm --prefix demos/vanilla ci --ignore-scripts \
  && YUMCUT_DEMO_BASE_PATH=/vanilla/ YUMCUT_SOURCE_MAPS=0 npm --prefix demos/vanilla run build \
  && npm --prefix demos/react-vite ci --ignore-scripts \
  && YUMCUT_DEMO_BASE_PATH=/react/ YUMCUT_SOURCE_MAPS=0 npm --prefix demos/react-vite run build \
  && npm --prefix demos/nextjs ci --ignore-scripts \
  && NEXT_TELEMETRY_DISABLED=1 YUMCUT_DEMO_BASE_PATH=/nextjs YUMCUT_STATIC_EXPORT=1 npm --prefix demos/nextjs run build

FROM nginx:1.29-alpine AS runtime

LABEL org.opencontainers.image.title="YumCut Video Ads demo hub" \
  org.opencontainers.image.description="Browser video-composition demos for Next.js, React, and vanilla TypeScript" \
  org.opencontainers.image.source="https://github.com/IgorShadurin/yumcut-video-ads" \
  org.opencontainers.image.licenses="MIT"

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/index.html /usr/share/nginx/html/index.html
COPY --from=builder /app/demos/nextjs/out/ /usr/share/nginx/html/nextjs/
COPY --from=builder /app/demos/react-vite/dist/ /usr/share/nginx/html/react/
COPY --from=builder /app/demos/vanilla/dist/ /usr/share/nginx/html/vanilla/

# A stable shared media route is useful for smoke checks and attribution. The demos
# keep their own copies so each build also remains independently deployable.
COPY --from=builder /app/demos/vanilla/public/media/ /usr/share/nginx/html/media/
COPY deploy/media-index.html /usr/share/nginx/html/media/index.html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
