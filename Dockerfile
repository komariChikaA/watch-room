FROM node:22-alpine AS web
WORKDIR /src
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json ./server/package.json
RUN npm install --omit=dev --prefix server
COPY server ./server
COPY --from=web /src/dist ./web/dist
ENV STATIC_DIR=/app/web/dist
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/src/index.js"]
