# =========================================================================
# 基于 jina-reader 镜像扩展(已含 Node 24 + headless Chrome + puppeteer + koa)
# 我们的整合服务器覆盖其默认启动,复用其环境(/app/node_modules、build 产物)
# =========================================================================
FROM ghcr.io/jina-ai/reader:latest

WORKDIR /app

# 补装我们独有的运行时依赖进 /app/node_modules 共享树
# (镜像已自带 typescript、koa、@koa/bodyparser 等,无需重复安装)
RUN npm install --no-save @modelcontextprotocol/sdk@^1.29.0

# 放入我们的 TS 工程并构建到 /app/extension
COPY package.json tsconfig.json ./
COPY src ./src
RUN mkdir -p /app/extension \
  && cp -r ./src /app/extension/src \
  && cp package.json tsconfig.json /app/extension/ \
  && cd /app/extension \
  && /app/node_modules/.bin/tsc -p tsconfig.json \
  && rm -rf /app/extension/src

# 覆盖默认启动(entrypoint 保持 node);监听端口由环境变量 PORT 控制(默认 18081)
CMD ["/app/extension/dist/index.js"]
