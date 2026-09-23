# 纯前端静态产物：构建后用 vite preview 提供页面（无后端、无外调）
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# preview 只需 vite 本体（dist 已是纯静态产物，不依赖 React 插件）
COPY --from=build /app/node_modules/vite ./node_modules/vite
COPY --from=build /app/node_modules/.bin ./node_modules/.bin
COPY --from=build /app/dist ./dist
COPY vite.config.ts ./vite.config.ts

EXPOSE 8000
# 容器内固定监听 8000；宿主映射端口由 WEB_PORT 决定（见 docker-compose.yml）。
CMD ["node", "node_modules/vite/bin/vite.js", "preview", "--host", "0.0.0.0", "--port", "8000"]
