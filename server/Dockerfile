FROM node:22-alpine
RUN corepack enable
WORKDIR /app

# 先复制清单以利用 Docker 层缓存
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/

RUN pnpm install --dangerously-allow-all-builds

# 复制源码（shared 是 server 的运行时依赖）
COPY shared shared
COPY server server

EXPOSE 2567
CMD ["pnpm", "--filter", "@richman/server", "start"]


