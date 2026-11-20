# Oreol Glass MVP

Демонстрация мессенджера с двумя текстовыми каналами и голосовой комнатой. FastAPI обслуживает интерфейс и WebSocket для текста. SQLite хранит историю. LiveKit и WebRTC передают звук.

Для запуска на VPS используй [инструкцию по развёртыванию](deploy/README.md).

## Генерация ключей LiveKit

Запусти эти команды в папке проекта. Понадобится Python 3.

```bash
(
  umask 077
  python3 - <<'PYTHON'
import secrets
from pathlib import Path

template = Path(".env.example").read_text(encoding="utf-8")
with open(".env", "x", encoding="utf-8") as config:
    config.write(
        template.replace("LK_API_KEY=\n", f"LK_API_KEY={secrets.token_hex(12)}\n")
        .replace("LK_API_SECRET=\n", f"LK_API_SECRET={secrets.token_hex(32)}\n")
    )
PYTHON
)
```

Если `.env` уже есть, используй его. Команда создаёт новый файл с правами `0600`. Храни `.env` отдельно от передаваемого архива.

## Локальный запуск через Docker Compose

```bash
docker compose up --build -d
```

Открой [127.0.0.1:8000](http://127.0.0.1:8000). Для проверки чата и голоса открой вторую вкладку, войди с другим именем и разреши доступ к микрофону при входе в Lounge. Браузер загружает клиент LiveKit с jsDelivr, поэтому для голосовой комнаты нужен доступ к CDN.

Для остановки выполни `docker compose down`. История остаётся в томе `chat-data`. При первом запуске приложение создаёт пустую базу.

## Только текстовый чат без Docker

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python main.py
```

Для голоса при ручном запуске потребуются собственный сервер LiveKit и переменные `LK_SERVER_URL`, `LK_API_KEY`, `LK_API_SECRET`. Через `LK_API_URL` можно отдельно указать адрес API, доступный серверу приложения.

## Границы демонстрации

Локальный Compose публикует порты на loopback. Вход по имени, чтение истории, выдача голосовых токенов и очистка чата доступны без проверки прав. Сценарий для VPS закрывает демо паролем на уровне Nginx. Пользователи, которым выдан доступ, могут читать и очищать историю комнат.
