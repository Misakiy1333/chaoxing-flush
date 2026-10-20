FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY *.js ./
COPY config.json* ./
EXPOSE 8765
CMD ["node", "cloud.js", "--watch"]
