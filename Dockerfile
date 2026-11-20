# 1) Сборка фронтенда (web/ → web/dist)
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 2) Бэкенд FastAPI + готовая статика
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
COPY --from=web /web/dist ./web/dist
ENV DB_NAME=/data/chat.db
# Порт задаётся из compose (APP_PORT); слушаем только localhost — наружу отдаёт nginx
CMD ["sh", "-c", "uvicorn main:app --host 127.0.0.1 --port ${APP_PORT:-8100} --proxy-headers --forwarded-allow-ips=127.0.0.1"]
