FROM node:20-alpine
WORKDIR /app

# 只装运行依赖
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# 业务代码
COPY *.js ./
COPY web ./web

# 数据目录（用户、题库）挂载出来
VOLUME ["/app/data"]
ENV PORT=8080
ENV MAX_RUNNING=30

EXPOSE 8080
CMD ["node", "server-multi.js"]
