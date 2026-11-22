import uvicorn
import asyncio
import time
import sqlite3
import os
import json
import re
from pathlib import Path
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from livekit import api

app = FastAPI()


def load_env_file(path: Path) -> None:
    """Подхватывает .env при запуске без Docker (python main.py). Переменные окружения важнее."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file(Path(__file__).parent / ".env")

# --- КОНФИГУРАЦИЯ ---
LK_SERVER_URL = os.getenv("LK_SERVER_URL", "ws://127.0.0.1:7880")
LK_API_URL = os.getenv("LK_API_URL", LK_SERVER_URL.replace("wss://", "https://").replace("ws://", "http://"))
LK_API_KEY = os.getenv("LK_API_KEY")
LK_API_SECRET = os.getenv("LK_API_SECRET")
DB_NAME = os.getenv("DB_NAME", "chat.db")
VOICE_ROOM_NAME = os.getenv("VOICE_ROOM_NAME", "Voice-Lounge")


def track_source(track) -> int:
    """Источник трека LiveKit (protobuf-перечисление — число): 1 камера, 2 микрофон, 3 экран."""
    try:
        return int(getattr(track, "source", 0) or 0)
    except (TypeError, ValueError):
        return 0


def live_tracks(participant, source: int) -> list:
    return [t for t in getattr(participant, "tracks", []) if track_source(t) == source]


def is_participant_muted(participant) -> bool:
    # Как в приложении: нет трека микрофона или он заглушён — микрофон выключен.
    # Раньше тип трека сравнивали со строкой «audio», а LiveKit отдаёт числа — выключенный микрофон не находился никогда.
    mics = live_tracks(participant, 2)
    return not mics or all(getattr(t, "muted", False) for t in mics)


def has_live_track(participant, source: int) -> bool:
    return any(not getattr(t, "muted", False) for t in live_tracks(participant, source))


def is_participant_deafened(participant) -> bool:
    try:
        return bool(json.loads(participant.metadata or "{}").get("deafened"))
    except (ValueError, AttributeError):
        return False


# --- БАЗА ДАННЫХ (SQLite) ---
def init_db():
    """Создает таблицу сообщений, если её нет"""
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room TEXT NOT NULL,
            username TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    conn.close()


def save_message(room, user, content):
    content = content.strip()
    if not content:
        return

    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute("INSERT INTO messages (room, username, content) VALUES (?, ?, ?)",
              (room, user, content))
    conn.commit()
    conn.close()


def get_history(room, limit=50):
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row  # Чтобы обращаться по именам колонок
    c = conn.cursor()
    c.execute("SELECT username, content, timestamp FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?",
              (room, limit))
    rows = c.fetchall()
    conn.close()
    # Разворачиваем список, чтобы старые были сверху
    history = [{"user": r["username"], "content": r["content"], "timestamp": r["timestamp"]} for r in rows]
    return history[::-1]


# Инициализируем БД при старте
init_db()


# --- ОЧИСТКА ЧАТА ---
@app.delete("/clear_chat/{room_name}")
async def clear_chat(room_name: str):
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute("DELETE FROM messages WHERE room = ?", (room_name,))
    conn.commit()
    conn.close()
    return {"ok": True}


# --- LIVEKIT TOKEN ---
@app.post("/get_token")
async def get_token(request: Request):
    if not LK_API_KEY or not LK_API_SECRET:
        return JSONResponse({"error": "LiveKit credentials are not configured"}, status_code=503)

    try:
        data = await request.json()
        username = (data.get("username") or "").strip()
        room_name = (data.get("room_name") or VOICE_ROOM_NAME).strip()

        if not username or not room_name:
            return JSONResponse({"error": "username and room_name are required"}, status_code=400)

        grant = api.VideoGrants(room_join=True, room=room_name)
        token = api.AccessToken(LK_API_KEY, LK_API_SECRET) \
            .with_identity(username) \
            .with_name(username) \
            .with_grants(grant) \
            .to_jwt()

        return {"token": token, "url": LK_SERVER_URL}
    except Exception:
        return JSONResponse({"error": "Could not issue a LiveKit token"}, status_code=500)


@app.get("/participants/{room_name}")
async def get_room_participants(room_name: str):
    if not LK_API_KEY or not LK_API_SECRET:
        return JSONResponse({"participants": []})

    lk_api = None
    try:
        # Используем LiveKit API чтобы узнать, кто в комнате
        lk_api = api.LiveKitAPI(LK_API_URL, LK_API_KEY, LK_API_SECRET)
        results = await lk_api.room.list_participants(api.ListParticipantsRequest(room=room_name))

        # Собираем список имен
        participants = [
            {
                "identity": p.identity,
                "name": p.name or p.identity,
                "isMuted": is_participant_muted(p),
                "deafened": is_participant_deafened(p),
                "camera": has_live_track(p, 1),
                "screen": has_live_track(p, 3),
                # с какого устройства зашёл (атрибут из токена) — для иконки телефона у ника
                "mobile": p.attributes.get("device") == "mobile",
            }
            for p in results.participants
        ]
        return JSONResponse({"participants": participants})
    except Exception as e:
        # Если комнаты нет или ошибка, возвращаем пустой список
        print(f"Error fetching participants: {e}")
        return JSONResponse({"participants": []})
    finally:
        if lk_api:
            await lk_api.aclose()

# --- WEBSOCKETS (TEXT CHAT) ---
class ConnectionManager:
    def __init__(self):
        # Словарь: ключ = название комнаты, значение = список WebSocket объектов
        self.active_connections: dict[str, list[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, room: str):
        await websocket.accept()
        if room not in self.active_connections:
            self.active_connections[room] = []
        self.active_connections[room].append(websocket)

    def disconnect(self, websocket: WebSocket, room: str):
        if room in self.active_connections:
            if websocket in self.active_connections[room]:
                self.active_connections[room].remove(websocket)
            if not self.active_connections[room]:
                del self.active_connections[room]

    async def broadcast(self, message: dict, room: str):
        if room in self.active_connections:
            for connection in self.active_connections[room].copy():
                await connection.send_json(message)


manager = ConnectionManager()


@app.websocket("/ws/{room_name}/{username}")
async def websocket_endpoint(websocket: WebSocket, room_name: str, username: str):
    await manager.connect(websocket, room_name)

    # 1. При подключении отправляем историю чата
    history = get_history(room_name)
    await websocket.send_json(history)

    try:
        while True:
            # 2. Ждем сообщение от клиента
            data = await websocket.receive_text()

            # 3. Сохраняем в БД
            data = data.strip()
            if not data:
                continue

            save_message(room_name, username, data)

            # 4. Рассылаем всем в этой комнате
            msg_obj = {"user": username, "msg": data}  # timestamp добавим на клиенте или вернем из базы
            await manager.broadcast(msg_obj, room_name)

    except WebSocketDisconnect:
        manager.disconnect(websocket, room_name)


# =====================================================================
# API v2 для нового фронтенда (web/). Старые эндпоинты выше остаются
# для legacy-страницы index.html (/legacy).
# =====================================================================

# Серверы: у каждого свой #general, свой чат «Лобби» и своя голосовая комната.
# У «Ореол Гейминг» (rg) комнаты без префикса — так сохраняется старая история.
SERVERS = {
    "rg": {"voice": VOICE_ROOM_NAME},
    "am": {"voice": os.getenv("VOICE_ROOM_AM", "Voice-Academy")},
    "ai": {"voice": os.getenv("VOICE_ROOM_AI", "Voice-AIClub")},
}


def chat_room(server: str, channel: str) -> str:
    return channel if server == "rg" else f"{server}-{channel}"


CHAT_ROOMS = {chat_room(sv, ch) for sv in SERVERS for ch in ("general", "lobby")}


def voice_room(server: str | None) -> str:
    return SERVERS.get(server or "rg", SERVERS["rg"])["voice"]
MAX_NAME_LEN = 32
MAX_MESSAGE_LEN = 2000


def to_iso(ts: str | None) -> str | None:
    # SQLite CURRENT_TIMESTAMP хранит UTC в виде "YYYY-MM-DD HH:MM:SS".
    return ts.replace(" ", "T") + "Z" if ts else None


def init_chat_features():
    """Ответы, правки, закрепы, пересылка и «удалить у себя» — новые колонки и таблица скрытых сообщений."""
    conn = sqlite3.connect(DB_NAME)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(messages)").fetchall()}
    for name, decl in (
        ("reply_to", "INTEGER"),
        ("edited_at", "DATETIME"),
        ("pinned", "INTEGER NOT NULL DEFAULT 0"),
        ("fwd_user", "TEXT"),
        ("fwd_ts", "DATETIME"),
        ("sys", "TEXT"),  # служебное событие в ленте: 'pin' / 'unpin' — «закрепил / открепил сообщение» (reply_to → какое)
    ):
        if name not in cols:
            conn.execute(f"ALTER TABLE messages ADD COLUMN {name} {decl}")
    # До какого сообщения пользователь дочитал комнату — для галочек «прочитано»
    conn.execute(
        """CREATE TABLE IF NOT EXISTS chat_reads (
            user_id INTEGER NOT NULL,
            room TEXT NOT NULL,
            last_id INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user_id, room)
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS message_hidden (
            user_id INTEGER NOT NULL,
            message_id INTEGER NOT NULL,
            PRIMARY KEY (user_id, message_id)
        )"""
    )
    conn.commit()
    conn.close()


init_chat_features()


# =====================================================================
# Вложения: пока только фото. Файлы лежат в S3 (Timeweb Cloud), бэкенд отдаёт их
# по /api/media/<key> — бакет может оставаться приватным. Фото загружается заранее
# (POST /api/attachments), а сообщение потом ссылается на id загруженных фото.
# =====================================================================
import io
import threading
import uuid
from datetime import datetime, timezone

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError
from fastapi.responses import Response, StreamingResponse
from PIL import Image, UnidentifiedImageError

S3_ENDPOINT = os.getenv("S3_ENDPOINT", "https://s3.twcstorage.ru")
S3_BUCKET = os.getenv("S3_BUCKET", "3e88f5e3-35cc-4a02-9d3c-95cfbb3707c0")
S3_REGION = os.getenv("S3_REGION", "ru-1")
S3_ACCESS_KEY = os.getenv("S3_ACCESS_KEY")
S3_SECRET_KEY = os.getenv("S3_SECRET_KEY")

MAX_PHOTO_BYTES = 10 * 1024 * 1024  # 10 МБ на одно фото
MAX_PHOTO_SIDE = 10_000  # по любой стороне, px
MAX_PHOTO_PIXELS = 40_000_000  # ~40 Мп — защита от «бомб» распаковки
MIN_PHOTO_SIDE = 1
MAX_PHOTOS = 10  # фото в одном сообщении
STALE_UPLOAD_HOURS = 24  # загружено, но так и не отправлено — удаляем
Image.MAX_IMAGE_PIXELS = MAX_PHOTO_PIXELS
# Что Pillow нашёл внутри файла → (MIME, расширение). Заголовку Content-Type не доверяем.
PHOTO_FORMATS = {"JPEG": ("image/jpeg", "jpg"), "PNG": ("image/png", "png"), "WEBP": ("image/webp", "webp"), "GIF": ("image/gif", "gif")}
MEDIA_KEY_RE = re.compile(r"^photos/\d{4}/\d{2}/[0-9a-f]{32}\.(?:jpg|png|webp|gif)$")

_s3_client = None


def s3():
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client(
            "s3",
            endpoint_url=S3_ENDPOINT,
            region_name=S3_REGION,
            aws_access_key_id=S3_ACCESS_KEY,
            aws_secret_access_key=S3_SECRET_KEY,
            config=BotoConfig(signature_version="s3v4", s3={"addressing_style": "path"}, retries={"max_attempts": 3}),
        )
    return _s3_client


def init_attachments_db():
    conn = sqlite3.connect(DB_NAME)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER,
            user_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            mime TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            size INTEGER NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
        CREATE INDEX IF NOT EXISTS attachments_key ON attachments(key);
        """
    )
    conn.commit()
    conn.close()


init_attachments_db()


def media_url(key: str) -> str:
    return f"/api/media/{key}"


def attachments_of(conn, message_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT id, key, width, height FROM attachments WHERE message_id = ? ORDER BY position, id", (message_id,)
    ).fetchall()
    return [{"id": a["id"], "url": media_url(a["key"]), "w": a["width"], "h": a["height"]} for a in rows]


def purge_s3_keys(keys) -> None:
    """Удаляет объекты из бакета в фоне — ответ пользователю не ждёт сети."""
    keys = [k for k in set(keys) if k]
    if not keys or not S3_ACCESS_KEY:
        return

    def run():
        try:
            for i in range(0, len(keys), 1000):
                s3().delete_objects(
                    Bucket=S3_BUCKET, Delete={"Objects": [{"Key": k} for k in keys[i : i + 1000]], "Quiet": True}
                )
        except (BotoCoreError, ClientError) as e:
            print(f"s3 delete: {e}")

    threading.Thread(target=run, daemon=True).start()


def drop_attachments(conn, where: str, args: tuple) -> list[str]:
    """Удаляет строки вложений по условию и возвращает ключи, на которые больше никто не ссылается
    (пересланное сообщение использует тот же файл, что и оригинал). Коммит — на вызывающем."""
    keys = [r[0] for r in conn.execute(f"SELECT DISTINCT key FROM attachments WHERE {where}", args).fetchall()]
    conn.execute(f"DELETE FROM attachments WHERE {where}", args)
    if not keys:
        return []
    marks = ",".join("?" * len(keys))
    still = {r[0] for r in conn.execute(f"SELECT DISTINCT key FROM attachments WHERE key IN ({marks})", keys).fetchall()}
    return [k for k in keys if k not in still]


def photo_info(body: bytes):
    """(MIME, расширение, ширина, высота) или текст ошибки. Размеры — как фото покажет браузер (с учётом EXIF-поворота)."""
    try:
        with Image.open(io.BytesIO(body)) as img:
            fmt = PHOTO_FORMATS.get(img.format or "")
            if not fmt:
                return "Поддерживаются JPG, PNG, WEBP и GIF"
            w, h = img.size
            try:
                if img.getexif().get(0x0112) in (5, 6, 7, 8):  # повёрнуто на 90° — стороны меняются местами
                    w, h = h, w
            except Exception:
                pass
    except Image.DecompressionBombError:
        return f"Слишком большое разрешение — максимум {MAX_PHOTO_PIXELS // 1_000_000} Мп"
    except (UnidentifiedImageError, OSError, ValueError):
        return "Файл не похож на изображение"
    if min(w, h) < MIN_PHOTO_SIDE:
        return "Пустое изображение"
    if max(w, h) > MAX_PHOTO_SIDE or w * h > MAX_PHOTO_PIXELS:
        return f"Слишком большое разрешение — до {MAX_PHOTO_SIDE} px по стороне и {MAX_PHOTO_PIXELS // 1_000_000} Мп"
    return (*fmt, w, h)


def purge_stale_uploads():
    """Фото, загруженные, но так и не отправленные за сутки."""
    conn = sqlite3.connect(DB_NAME)
    keys = drop_attachments(
        conn, "message_id IS NULL AND created_at < datetime('now', ?)", (f"-{STALE_UPLOAD_HOURS} hours",)
    )
    conn.commit()
    conn.close()
    purge_s3_keys(keys)


@app.post("/api/attachments")
async def attachment_upload(request: Request):
    """Тело запроса — само фото. Ответ: {id, url, w, h}; id потом передаётся в сообщении."""
    row = current_user(request)
    if not row:
        return unauthorized()
    if not S3_ACCESS_KEY or not S3_SECRET_KEY:
        return JSONResponse({"error": "Хранилище файлов не настроено на сервере"}, status_code=503)
    too_big = JSONResponse({"error": f"Фото больше {MAX_PHOTO_BYTES // (1024 * 1024)} МБ"}, status_code=413)
    try:
        if int(request.headers.get("content-length") or 0) > MAX_PHOTO_BYTES:
            return too_big
    except ValueError:
        pass
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_PHOTO_BYTES:
            return too_big
    if not body:
        return JSONResponse({"error": "Пустой файл"}, status_code=400)
    body = bytes(body)
    info = await asyncio.to_thread(photo_info, body)
    if isinstance(info, str):
        return JSONResponse({"error": info}, status_code=415)
    mime, ext, w, h = info
    now = datetime.now(timezone.utc)
    key = f"photos/{now:%Y}/{now:%m}/{uuid.uuid4().hex}.{ext}"
    try:
        await asyncio.to_thread(
            s3().put_object,
            Bucket=S3_BUCKET,
            Key=key,
            Body=body,
            ContentType=mime,
            CacheControl="public, max-age=31536000, immutable",
        )
    except (BotoCoreError, ClientError) as e:
        print(f"s3 upload: {e}")
        return JSONResponse({"error": "Не удалось сохранить фото, попробуйте ещё раз"}, status_code=502)
    conn = db()
    cur = conn.execute(
        "INSERT INTO attachments (user_id, key, mime, width, height, size) VALUES (?, ?, ?, ?, ?, ?)",
        (row["id"], key, mime, w, h, len(body)),
    )
    conn.commit()
    conn.close()
    asyncio.create_task(asyncio.to_thread(purge_stale_uploads))
    return {"id": cur.lastrowid, "url": media_url(key), "w": w, "h": h}


@app.delete("/api/attachments/{att_id}")
async def attachment_cancel(att_id: int, request: Request):
    """Убрали фото из поля ввода до отправки."""
    row = current_user(request)
    if not row:
        return unauthorized()
    conn = db()
    keys = drop_attachments(conn, "id = ? AND user_id = ? AND message_id IS NULL", (att_id, row["id"]))
    conn.commit()
    conn.close()
    purge_s3_keys(keys)
    return {"ok": True}


@app.get("/api/media/{key:path}")
async def media(key: str):
    # Отдаём только то, что записано в базе: по этому адресу нельзя прочитать произвольный объект бакета
    if not MEDIA_KEY_RE.match(key):
        return JSONResponse({"error": "not found"}, status_code=404)
    conn = db()
    att = conn.execute("SELECT mime FROM attachments WHERE key = ? LIMIT 1", (key,)).fetchone()
    conn.close()
    if not att or not S3_ACCESS_KEY:
        return JSONResponse({"error": "not found"}, status_code=404)
    try:
        obj = await asyncio.to_thread(s3().get_object, Bucket=S3_BUCKET, Key=key)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("NoSuchKey", "404"):
            return JSONResponse({"error": "not found"}, status_code=404)
        print(f"s3 get: {e}")
        return Response(status_code=502)
    except BotoCoreError as e:
        print(f"s3 get: {e}")
        return Response(status_code=502)
    headers = {"Cache-Control": "public, max-age=31536000, immutable"}
    if obj.get("ContentLength") is not None:
        headers["Content-Length"] = str(obj["ContentLength"])
    # Тело читается кусками в пуле потоков — большие фото не держим в памяти целиком
    return StreamingResponse(obj["Body"].iter_chunks(64 * 1024), media_type=att["mime"], headers=headers)


MSG_COLS = "id, room, username, content, timestamp, reply_to, edited_at, pinned, fwd_user, fwd_ts, sys"


def reply_text(conn, q) -> str:
    """Короткий текст для цитаты/закрепа: сам текст, а у сообщения из одних фото — «Фото»."""
    if q["content"]:
        return q["content"][:200]
    n = conn.execute("SELECT COUNT(*) FROM attachments WHERE message_id = ?", (q["id"],)).fetchone()[0]
    return "Фото" if n == 1 else f"Фото · {n}" if n else ""


def first_photo(conn, message_id: int) -> str | None:
    """Адрес первого фото сообщения — миниатюра в цитате ответа."""
    a = conn.execute(
        "SELECT key FROM attachments WHERE message_id = ? ORDER BY position, id LIMIT 1", (message_id,)
    ).fetchone()
    return media_url(a[0]) if a else None


def msg_json(conn, r) -> dict:
    reply = None
    if r["reply_to"]:
        q = conn.execute("SELECT id, username, content FROM messages WHERE id = ?", (r["reply_to"],)).fetchone()
        reply = (
            {"id": q["id"], "user": q["username"], "content": reply_text(conn, q), "photo": first_photo(conn, q["id"])}
            if q
            else {"id": r["reply_to"], "deleted": True}
        )
    return {
        "id": r["id"],
        "user": r["username"],
        "content": r["content"],
        "ts": to_iso(r["timestamp"]),
        "edited": to_iso(r["edited_at"]),
        "pinned": bool(r["pinned"]),
        "reply": reply,
        "fwd": {"user": r["fwd_user"], "ts": to_iso(r["fwd_ts"])} if r["fwd_user"] else None,
        "sys": r["sys"],
        "attachments": attachments_of(conn, r["id"]),
        # Сколько раз на сообщение ответили
        "replies": conn.execute(
            "SELECT COUNT(*) FROM messages WHERE reply_to = ? AND sys IS NULL", (r["id"],)
        ).fetchone()[0],
    }


def chat_conn():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn


def get_history_v2(room: str, limit: int = 100, user_id: int | None = None):
    conn = chat_conn()
    hidden = "AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)" if user_id else ""
    args = (room, user_id, limit) if user_id else (room, limit)
    rows = conn.execute(
        f"SELECT {MSG_COLS} FROM messages WHERE room = ? {hidden} ORDER BY id DESC LIMIT ?", args
    ).fetchall()
    out = [msg_json(conn, r) for r in reversed(rows)]
    conn.close()
    return out


def get_pinned(room: str, user_id: int | None = None):
    conn = chat_conn()
    hidden = "AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)" if user_id else ""
    args = (room, user_id) if user_id else (room,)
    rows = conn.execute(f"SELECT {MSG_COLS} FROM messages WHERE room = ? AND pinned = 1 {hidden} ORDER BY id", args).fetchall()
    out = [msg_json(conn, r) for r in rows]
    conn.close()
    return out


def get_message(msg_id) -> dict | None:
    conn = chat_conn()
    r = conn.execute(f"SELECT {MSG_COLS} FROM messages WHERE id = ?", (msg_id,)).fetchone()
    out = (dict(r), msg_json(conn, r)) if r else None
    conn.close()
    return out


def save_system_message(room: str, user: str, kind: str, ref_id: int):
    """Служебная строка в ленте («X закрепил сообщение»): хранится как сообщение с sys=kind."""
    conn = chat_conn()
    cur = conn.execute(
        "INSERT INTO messages (room, username, content, reply_to, sys) VALUES (?, ?, '', ?, ?)",
        (room, user, ref_id, kind),
    )
    conn.commit()
    r = conn.execute(f"SELECT {MSG_COLS} FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone()
    out = msg_json(conn, r)
    conn.close()
    return out


def save_message_v2(
    room: str,
    user: str,
    content: str,
    reply_to=None,
    fwd_user=None,
    fwd_ts=None,
    owner_id: int | None = None,
    attachment_ids: list[int] | None = None,
    copy_attachments_from: int | None = None,
):
    """attachment_ids — свои загруженные, ещё не отправленные фото (owner_id — кто загрузил);
    copy_attachments_from — при пересылке берём фото исходного сообщения (тот же файл в бакете).
    Пустое сообщение без фото не сохраняется — возвращается None."""
    conn = chat_conn()
    if reply_to is not None:
        ok = conn.execute("SELECT 1 FROM messages WHERE id = ? AND room = ? AND sys IS NULL", (reply_to, room)).fetchone()
        if not ok:
            reply_to = None
    ids: list[int] = []
    if attachment_ids and owner_id is not None:
        wanted = list(dict.fromkeys(attachment_ids))[:MAX_PHOTOS]
        marks = ",".join("?" * len(wanted))
        free = {
            r[0]
            for r in conn.execute(
                f"SELECT id FROM attachments WHERE id IN ({marks}) AND user_id = ? AND message_id IS NULL", (*wanted, owner_id)
            ).fetchall()
        }
        ids = [i for i in wanted if i in free]  # порядок — как выбрал пользователь
    copy_from = copy_attachments_from is not None and conn.execute(
        "SELECT 1 FROM attachments WHERE message_id = ?", (copy_attachments_from,)
    ).fetchone()
    if not content and not ids and not copy_from:
        conn.close()
        return None
    cur = conn.execute(
        "INSERT INTO messages (room, username, content, reply_to, fwd_user, fwd_ts) VALUES (?, ?, ?, ?, ?, ?)",
        (room, user, content, reply_to, fwd_user, fwd_ts),
    )
    for pos, att in enumerate(ids):
        conn.execute("UPDATE attachments SET message_id = ?, position = ? WHERE id = ?", (cur.lastrowid, pos, att))
    if copy_from:
        conn.execute(
            "INSERT INTO attachments (message_id, user_id, key, mime, width, height, size, position) "
            "SELECT ?, user_id, key, mime, width, height, size, position FROM attachments WHERE message_id = ?",
            (cur.lastrowid, copy_attachments_from),
        )
    conn.commit()
    r = conn.execute(f"SELECT {MSG_COLS} FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone()
    out = msg_json(conn, r)
    conn.close()
    return out


def get_reads(room: str) -> dict:
    """{username: id последнего прочитанного сообщения} по комнате."""
    conn = chat_conn()
    rows = conn.execute(
        "SELECT u.username, r.last_id FROM chat_reads r JOIN users u ON u.id = r.user_id WHERE r.room = ?", (room,)
    ).fetchall()
    conn.close()
    return {r["username"]: r["last_id"] for r in rows}


def mark_read(user_id: int, room: str, last_id: int) -> bool:
    """Сдвигает отметку вперёд (назад — никогда). True, если она изменилась."""
    conn = chat_conn()
    cur = conn.execute("SELECT last_id FROM chat_reads WHERE user_id = ? AND room = ?", (user_id, room)).fetchone()
    if cur and cur["last_id"] >= last_id:
        conn.close()
        return False
    conn.execute(
        "INSERT INTO chat_reads (user_id, room, last_id) VALUES (?, ?, ?) "
        "ON CONFLICT(user_id, room) DO UPDATE SET last_id = excluded.last_id",
        (user_id, room, last_id),
    )
    conn.commit()
    conn.close()
    return True


def as_ids(value) -> list[int]:
    items = value if isinstance(value, list) else [value]
    out = []
    for v in items[:100]:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            pass
    return out


NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9 ._-]{1,31}$")


def clean_name(value: str) -> str:
    """Имя при входе — только латиница. Возвращает пустую строку, если имя не подходит."""
    name = " ".join((value or "").split())[:MAX_NAME_LEN]
    return name if NAME_RE.match(name) else ""


# =====================================================================
# Аккаунты (мини-регистрация для своих): email + пароль, без подтверждения почты.
# Пароли — scrypt из стандартной библиотеки, сессии — случайный токен в таблице sessions.
# Аватар и фон профиля хранятся файлами в UPLOADS_DIR и отдаются по /api/uploads/...
# =====================================================================
import hashlib
import hmac
import secrets

UPLOADS_DIR = Path(os.getenv("UPLOADS_DIR", Path(DB_NAME).resolve().parent / "uploads"))
(UPLOADS_DIR / "avatars").mkdir(parents=True, exist_ok=True)
(UPLOADS_DIR / "banners").mkdir(parents=True, exist_ok=True)

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,24}$")
MIN_PASSWORD_LEN = 8
MAX_DISPLAY_LEN = 32
MAX_BIO_LEN = 190
IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
MAX_IMAGE = {"avatars": 3 * 1024 * 1024, "banners": 6 * 1024 * 1024}


def db():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn


def init_auth_db():
    conn = db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            bio TEXT NOT NULL DEFAULT '',
            avatar TEXT,
            banner TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        """
    )
    conn.commit()
    conn.close()


init_auth_db()

# ---------------------------------------------------------------------
# Серверы, каналы и участники живут в БД. Ниже — только начальное наполнение:
# три сервера с #general и голосовым «Лобби». Сервер с auto_join=1 автоматически
# получает в участники каждого зарегистрированного пользователя.
# ---------------------------------------------------------------------
STATUSES = ("online", "idle", "dnd", "offline")  # offline = «невидимый»
SEED_SERVERS = [
    ("rg", "RG", "Ореол Гейминг", "Сервер для рейдов и общения", "linear-gradient(135deg,#ff6fd8,#7a5cff)"),
    ("am", "АМ", "Академия Манипуляций", "Психология влияния и переговоры", "linear-gradient(135deg,#ffb36b,#ff5c7a)"),
    ("ai", "AI", "AI Club", "Нейросети, агенты и эксперименты", "linear-gradient(135deg,#3ddc97,#00a8cc)"),
]


def init_servers_db():
    conn = db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS servers (
            id TEXT PRIMARY KEY,
            short TEXT NOT NULL,
            name TEXT NOT NULL,
            about TEXT NOT NULL DEFAULT '',
            gradient TEXT NOT NULL,
            voice_room TEXT NOT NULL UNIQUE,
            auto_join INTEGER NOT NULL DEFAULT 1,
            position INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
            slug TEXT NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('text', 'voice')),
            room TEXT NOT NULL UNIQUE,
            position INTEGER NOT NULL DEFAULT 0,
            UNIQUE (server_id, slug)
        );
        CREATE TABLE IF NOT EXISTS server_members (
            server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (server_id, user_id)
        );
        """
    )
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    if "status" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'online'")
    if "phone" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN phone TEXT")
    if not conn.execute("SELECT 1 FROM servers LIMIT 1").fetchone():
        for pos, (sid, short, name, about, grad) in enumerate(SEED_SERVERS):
            conn.execute(
                "INSERT INTO servers (id, short, name, about, gradient, voice_room, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (sid, short, name, about, grad, SERVERS[sid]["voice"], pos),
            )
            conn.execute(
                "INSERT INTO channels (server_id, slug, name, kind, room, position) VALUES (?, 'general', 'general', 'text', ?, 0)",
                (sid, chat_room(sid, "general")),
            )
            conn.execute(
                "INSERT INTO channels (server_id, slug, name, kind, room, position) VALUES (?, 'lobby', 'Лобби', 'voice', ?, 1)",
                (sid, chat_room(sid, "lobby")),
            )
    # Уже зарегистрированные — участники всех auto_join-серверов (с даты регистрации)
    conn.execute(
        "INSERT OR IGNORE INTO server_members (server_id, user_id, joined_at) "
        "SELECT s.id, u.id, u.created_at FROM servers s, users u WHERE s.auto_join = 1"
    )
    conn.commit()
    conn.close()


init_servers_db()


def join_auto_servers(conn, user_id: int):
    conn.execute(
        "INSERT OR IGNORE INTO server_members (server_id, user_id) SELECT id, ? FROM servers WHERE auto_join = 1",
        (user_id,),
    )


def member_server(conn, user_id: int, server_id: str):
    """Сервер, если пользователь в нём состоит."""
    return conn.execute(
        "SELECT s.* FROM servers s JOIN server_members m ON m.server_id = s.id WHERE s.id = ? AND m.user_id = ?",
        (server_id, user_id),
    ).fetchone()


def member_channel(conn, user_id: int, room: str):
    """Канал по комнате чата, если пользователь — участник его сервера."""
    return conn.execute(
        "SELECT c.* FROM channels c JOIN server_members m ON m.server_id = c.server_id WHERE c.room = ? AND m.user_id = ?",
        (room, user_id),
    ).fetchone()



def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, salt_hex, digest_hex = stored.split("$")
        digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1, dklen=32)
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def upload_url(kind: str, file: str | None) -> str | None:
    return f"/api/uploads/{kind}/{file}" if file else None


def public_user(row) -> dict:
    return {
        "username": row["username"],
        "displayName": row["display_name"],
        "bio": row["bio"],
        "avatar": upload_url("avatars", row["avatar"]),
        "banner": upload_url("banners", row["banner"]),
        "createdAt": to_iso(row["created_at"]),
    }


def me_user(row) -> dict:
    return {**public_user(row), "id": row["id"], "email": row["email"], "phone": row["phone"], "status": row["status"]}


def new_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    conn = db()
    conn.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
    conn.commit()
    conn.close()
    return token


def user_by_token(token: str | None):
    if not token:
        return None
    conn = db()
    row = conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?", (token,)
    ).fetchone()
    conn.close()
    return row


def bearer(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else None


def current_user(request: Request):
    return user_by_token(bearer(request))


def unauthorized():
    return JSONResponse({"error": "Нужно войти в аккаунт"}, status_code=401)


@app.post("/api/auth/register")
async def auth_register(request: Request):
    data = await request.json()
    email = str(data.get("email", "")).strip().lower()
    username = clean_name(str(data.get("username", "")))
    display = " ".join(str(data.get("displayName", "")).split())[:MAX_DISPLAY_LEN] or username
    password = str(data.get("password", ""))
    errors = {}
    if not EMAIL_RE.match(email):
        errors["email"] = "Введите корректный email"
    if not username:
        errors["username"] = "Латиница, цифры, пробел, точка, дефис и _; начинается с буквы, 2–32 символа"
    if len(password) < MIN_PASSWORD_LEN:
        errors["password"] = f"Минимум {MIN_PASSWORD_LEN} символов"
    if errors:
        return JSONResponse({"error": "Проверьте поля", "fields": errors}, status_code=400)

    conn = db()
    if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
        errors["email"] = "Этот email уже зарегистрирован"
    if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        errors["username"] = "Это имя пользователя уже занято"
    if errors:
        conn.close()
        return JSONResponse({"error": "Проверьте поля", "fields": errors}, status_code=409)
    cur = conn.execute(
        "INSERT INTO users (email, username, display_name, password_hash) VALUES (?, ?, ?, ?)",
        (email, username, display, hash_password(password)),
    )
    user_id = cur.lastrowid
    join_auto_servers(conn, user_id)
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return {"token": new_session(user_id), "user": me_user(row)}


@app.post("/api/auth/login")
async def auth_login(request: Request):
    data = await request.json()
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    conn = db()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()
    if not row or not check_password(password, row["password_hash"]):
        return JSONResponse({"error": "Неверный email или пароль"}, status_code=401)
    return {"token": new_session(row["id"]), "user": me_user(row)}


@app.get("/api/auth/me")
async def auth_me(request: Request):
    row = current_user(request)
    return {"user": me_user(row)} if row else unauthorized()


@app.post("/api/auth/logout")
async def auth_logout(request: Request):
    token = bearer(request)
    if token:
        conn = db()
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
        conn.close()
    return {"ok": True}


@app.get("/api/users")
async def users_list(request: Request):
    if not current_user(request):
        return unauthorized()
    conn = db()
    rows = conn.execute("SELECT * FROM users ORDER BY username").fetchall()
    conn.close()
    return {"users": [public_user(r) for r in rows]}


@app.patch("/api/profile")
async def profile_update(request: Request):
    row = current_user(request)
    if not row:
        return unauthorized()
    data = await request.json()
    fields, values = [], []
    if "displayName" in data:
        display = " ".join(str(data["displayName"]).split())[:MAX_DISPLAY_LEN]
        if not display:
            return JSONResponse({"error": "Отображаемое имя не может быть пустым"}, status_code=400)
        fields.append("display_name = ?")
        values.append(display)
    if "bio" in data:
        fields.append("bio = ?")
        values.append(str(data["bio"]).strip()[:MAX_BIO_LEN])
    conn = db()
    if fields:
        conn.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = ?", (*values, row["id"]))
        conn.commit()
    fresh = conn.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
    conn.close()
    await hub.broadcast_all({"type": "profile", "user": public_user(fresh)})
    return {"user": me_user(fresh)}


def remove_upload(kind: str, file: str | None):
    if file:
        try:
            (UPLOADS_DIR / kind / Path(file).name).unlink(missing_ok=True)
        except OSError:
            pass


async def save_image(request: Request, kind: str):
    """PUT /api/profile/avatar|banner: тело запроса — сама картинка (Content-Type image/*)."""
    row = current_user(request)
    if not row:
        return unauthorized()
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    ext = IMAGE_TYPES.get(ctype)
    if not ext:
        return JSONResponse({"error": "Поддерживаются PNG, JPG, WEBP и GIF"}, status_code=415)
    body = await request.body()
    if not body:
        return JSONResponse({"error": "Пустой файл"}, status_code=400)
    if len(body) > MAX_IMAGE[kind]:
        mb = MAX_IMAGE[kind] // (1024 * 1024)
        return JSONResponse({"error": f"Файл больше {mb} МБ"}, status_code=413)
    column = "avatar" if kind == "avatars" else "banner"
    name = f"{row['id']}-{secrets.token_hex(6)}.{ext}"
    (UPLOADS_DIR / kind / name).write_bytes(body)
    conn = db()
    conn.execute(f"UPDATE users SET {column} = ? WHERE id = ?", (name, row["id"]))
    conn.commit()
    fresh = conn.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
    conn.close()
    remove_upload(kind, row[column])
    await hub.broadcast_all({"type": "profile", "user": public_user(fresh)})
    return {"user": me_user(fresh)}


async def delete_image(request: Request, kind: str):
    row = current_user(request)
    if not row:
        return unauthorized()
    column = "avatar" if kind == "avatars" else "banner"
    conn = db()
    conn.execute(f"UPDATE users SET {column} = NULL WHERE id = ?", (row["id"],))
    conn.commit()
    fresh = conn.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
    conn.close()
    remove_upload(kind, row[column])
    await hub.broadcast_all({"type": "profile", "user": public_user(fresh)})
    return {"user": me_user(fresh)}


@app.put("/api/profile/avatar")
async def profile_avatar(request: Request):
    return await save_image(request, "avatars")


@app.delete("/api/profile/avatar")
async def profile_avatar_delete(request: Request):
    return await delete_image(request, "avatars")


@app.put("/api/profile/banner")
async def profile_banner(request: Request):
    return await save_image(request, "banners")


@app.delete("/api/profile/banner")
async def profile_banner_delete(request: Request):
    return await delete_image(request, "banners")


app.mount("/api/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")



# ---------------------------------------------------------------------
# Учётная запись: имя, имя пользователя, email, телефон, пароль, удаление.
# ---------------------------------------------------------------------
def clean_phone(value: str) -> str | None:
    """Телефон хранится как +цифры (10–15 цифр). Пустое значение — телефона нет."""
    digits = re.sub(r"\D", "", value or "")
    if not digits:
        return ""
    return "+" + digits if 10 <= len(digits) <= 15 else None


@app.patch("/api/account")
async def account_update(request: Request):
    row = current_user(request)
    if not row:
        return unauthorized()
    data = await request.json()
    errors, updates = {}, {}
    if "displayName" in data:
        display = " ".join(str(data["displayName"]).split())[:MAX_DISPLAY_LEN]
        if display:
            updates["display_name"] = display
        else:
            errors["displayName"] = "Отображаемое имя не может быть пустым"
    if "username" in data:
        username = clean_name(str(data["username"]))
        if not username:
            errors["username"] = "Латиница, цифры, пробел, точка, дефис и _; начинается с буквы, 2–32 символа"
        elif username != row["username"]:
            updates["username"] = username
    if "email" in data:
        email = str(data["email"]).strip().lower()
        if not EMAIL_RE.match(email):
            errors["email"] = "Введите корректный email"
        elif email != row["email"]:
            updates["email"] = email
    if "phone" in data:
        phone = clean_phone(str(data["phone"] or ""))
        if phone is None:
            errors["phone"] = "Номер из 10–15 цифр, например +7 999 123-45-67"
        else:
            updates["phone"] = phone or None
    if errors:
        return JSONResponse({"error": "Проверьте поля", "fields": errors}, status_code=400)

    conn = db()
    if "email" in updates and conn.execute("SELECT 1 FROM users WHERE email = ? AND id != ?", (updates["email"], row["id"])).fetchone():
        errors["email"] = "Этот email уже зарегистрирован"
    if "username" in updates and conn.execute(
        "SELECT 1 FROM users WHERE username = ? AND id != ?", (updates["username"], row["id"])
    ).fetchone():
        errors["username"] = "Это имя пользователя уже занято"
    if errors:
        conn.close()
        return JSONResponse({"error": "Проверьте поля", "fields": errors}, status_code=409)
    if updates:
        sets = ", ".join(f"{k} = ?" for k in updates)
        conn.execute(f"UPDATE users SET {sets} WHERE id = ?", (*updates.values(), row["id"]))
        # История сообщений переезжает на новое имя пользователя
        if "username" in updates:
            conn.execute("UPDATE messages SET username = ? WHERE username = ?", (updates["username"], row["username"]))
        conn.commit()
    fresh = conn.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
    conn.close()
    if "username" in updates:
        await hub.broadcast_all({"type": "renamed", "from": row["username"], "user": public_user(fresh)})
    await hub.broadcast_all({"type": "profile", "user": public_user(fresh)})
    return {"user": me_user(fresh)}


@app.post("/api/account/password")
async def account_password(request: Request):
    row = current_user(request)
    if not row:
        return unauthorized()
    data = await request.json()
    current, new = str(data.get("current", "")), str(data.get("password", ""))
    if not check_password(current, row["password_hash"]):
        return JSONResponse({"error": "Неверный текущий пароль", "fields": {"current": "Неверный текущий пароль"}}, status_code=400)
    if len(new) < MIN_PASSWORD_LEN:
        return JSONResponse({"error": "Проверьте поля", "fields": {"password": f"Минимум {MIN_PASSWORD_LEN} символов"}}, status_code=400)
    conn = db()
    conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(new), row["id"]))
    # Остальные сессии завершаем — остаётся только текущая
    conn.execute("DELETE FROM sessions WHERE user_id = ? AND token != ?", (row["id"], bearer(request)))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/account")
async def account_delete(request: Request):
    row = current_user(request)
    if not row:
        return unauthorized()
    data = await request.json()
    if not check_password(str(data.get("password", "")), row["password_hash"]):
        return JSONResponse({"error": "Неверный пароль", "fields": {"password": "Неверный пароль"}}, status_code=400)
    conn = db()
    conn.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
    conn.execute("DELETE FROM server_members WHERE user_id = ?", (row["id"],))
    # Фото из его сообщений и неотправленные загрузки
    orphans = drop_attachments(
        conn,
        "message_id IN (SELECT id FROM messages WHERE username = ?) OR (message_id IS NULL AND user_id = ?)",
        (row["username"], row["id"]),
    )
    conn.execute("DELETE FROM messages WHERE username = ?", (row["username"],))
    conn.execute("DELETE FROM chat_reads WHERE user_id = ?", (row["id"],))
    conn.execute("DELETE FROM message_hidden WHERE user_id = ?", (row["id"],))
    conn.execute("DELETE FROM users WHERE id = ?", (row["id"],))
    conn.commit()
    conn.close()
    remove_upload("avatars", row["avatar"])
    remove_upload("banners", row["banner"])
    purge_s3_keys(orphans)
    await hub.broadcast_presence()
    return {"ok": True}


@app.post("/api/token")
async def api_token(request: Request):
    if not LK_API_KEY or not LK_API_SECRET:
        return JSONResponse({"error": "LiveKit не настроен на сервере"}, status_code=503)
    row = current_user(request)
    if not row:
        return unauthorized()
    data = await request.json()
    username = row["username"]
    conn = db()
    srv = member_server(conn, row["id"], str(data.get("server") or ""))
    conn.close()
    if not srv:
        return JSONResponse({"error": "Вы не участник этого сервера"}, status_code=403)
    room = srv["voice_room"]
    grant = api.VideoGrants(
        room_join=True,
        room=room,
        can_publish=True,
        can_subscribe=True,
        can_update_own_metadata=True,  # флаг «звук выключен» передаётся через metadata
    )
    token = (
        api.AccessToken(LK_API_KEY, LK_API_SECRET)
        .with_identity(username)
        .with_name(username)
        .with_grants(grant)
        # тип устройства задаётся клиентом по устройству (не по ширине окна) — показываем иконку телефона
        .with_attributes({"device": "mobile" if data.get("device") == "mobile" else "desktop"})
        .to_jwt()
    )
    VOICE_TOKEN_AT[username] = time.time()
    return {"token": token, "url": LK_SERVER_URL, "room": room}


# ===== Закрыли вкладку, будучи в голосовом =====
# Клиент не шлёт «выход» при уходе со страницы (чтобы перезагрузка не выкидывала из канала),
# а LiveKit держит «оборванного» участника долго. Поэтому страница при закрытии шлёт маяк,
# и если за VOICE_LEAVE_GRACE секунд тот же пользователь не переподключился — убираем его из комнаты.
VOICE_LEAVE_GRACE = 15
VOICE_TOKEN_AT: dict[str, float] = {}


async def drop_voice_later(username: str, room: str, since: float):
    await asyncio.sleep(VOICE_LEAVE_GRACE)
    if VOICE_TOKEN_AT.get(username, 0) > since:
        return  # перезагрузка: уже зашёл заново
    lk_api = None
    try:
        lk_api = api.LiveKitAPI(LK_API_URL, LK_API_KEY, LK_API_SECRET)
        await lk_api.room.remove_participant(api.RoomParticipantIdentity(room=room, identity=username))
    except Exception as e:
        print(f"voice drop {username}@{room}: {e}")
    finally:
        if lk_api:
            await lk_api.aclose()


@app.post("/api/voice/leaving")
async def api_voice_leaving(request: Request):
    """Маяк со страницы (navigator.sendBeacon) — без заголовков, токен в теле."""
    if not LK_API_KEY or not LK_API_SECRET:
        return {"ok": False}
    try:
        data = json.loads((await request.body()) or b"{}")
    except ValueError:
        return JSONResponse({"error": "bad body"}, status_code=400)
    row = user_by_token(str(data.get("auth") or ""))
    if not row:
        return unauthorized()
    conn = db()
    srv = member_server(conn, row["id"], str(data.get("server") or ""))
    conn.close()
    if not srv:
        return JSONResponse({"error": "Вы не участник этого сервера"}, status_code=403)
    asyncio.create_task(drop_voice_later(row["username"], srv["voice_room"], time.time()))
    return {"ok": True}


@app.get("/api/voice/participants")
async def api_voice_participants(server: str = "rg"):
    conn = db()
    srv = conn.execute("SELECT voice_room FROM servers WHERE id = ?", (server,)).fetchone()
    conn.close()
    if not srv:
        return JSONResponse({"error": "unknown server"}, status_code=400)
    return await get_room_participants(srv["voice_room"])


class ChatHub:
    """Комнаты чата: сокеты и список онлайн-пользователей."""

    def __init__(self):
        self.rooms: dict[str, list[tuple[WebSocket, str]]] = {}

    def users(self, room: str) -> list[str]:
        seen: list[str] = []
        for _, name in self.rooms.get(room, []):
            if name not in seen:
                seen.append(name)
        return seen

    def all_users(self) -> list[str]:
        seen: list[str] = []
        for room in self.rooms:
            for name in self.users(room):
                if name not in seen:
                    seen.append(name)
        return seen

    async def join(self, ws: WebSocket, room: str, user: str):
        self.rooms.setdefault(room, []).append((ws, user))
        await self.broadcast_presence()

    async def leave(self, ws: WebSocket, room: str):
        self.rooms[room] = [(w, n) for w, n in self.rooms.get(room, []) if w is not ws]
        if not self.rooms[room]:
            del self.rooms[room]
        await self.broadcast_presence()

    async def send(self, room: str, payload: dict, skip: WebSocket | None = None):
        for ws, _ in list(self.rooms.get(room, [])):
            if ws is skip:
                continue
            try:
                await ws.send_json(payload)
            except Exception:
                pass

    async def send_user(self, room: str, user: str, payload: dict):
        for ws, name in list(self.rooms.get(room, [])):
            if name == user:
                try:
                    await ws.send_json(payload)
                except Exception:
                    pass

    def statuses(self) -> dict[str, str]:
        """Видимый статус каждого подключённого. «Невидимые» не попадают — для всех они не в сети."""
        names = self.all_users()
        if not names:
            return {}
        conn = db()
        marks = ",".join("?" * len(names))
        rows = conn.execute(f"SELECT username, status FROM users WHERE username IN ({marks})", names).fetchall()
        conn.close()
        return {r["username"]: r["status"] for r in rows if r["status"] != "offline"}

    async def broadcast_all(self, payload: dict):
        for room in list(self.rooms):
            await self.send(room, payload)

    async def broadcast_presence(self):
        await self.broadcast_all({"type": "presence", "statuses": self.statuses()})


hub = ChatHub()


@app.websocket("/api/ws/{room}")
async def api_ws(websocket: WebSocket, room: str):
    row = user_by_token(websocket.query_params.get("token"))
    user = row["username"] if row else ""
    await websocket.accept()
    conn = db()
    channel = member_channel(conn, row["id"], room) if row else None
    conn.close()
    if not channel:
        await websocket.close(code=4400)
        return

    uid = row["id"]
    await websocket.send_json(
        {
            "type": "history",
            "messages": get_history_v2(room, user_id=uid),
            "pinned": get_pinned(room, uid),
            "reads": get_reads(room),
        }
    )
    await hub.join(websocket, room, user)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except ValueError:
                continue
            kind = data.get("type")
            if kind == "message":
                content = str(data.get("content", "")).strip()[:MAX_MESSAGE_LEN]
                reply_to = as_ids(data.get("reply_to"))[:1] if data.get("reply_to") is not None else []
                photos = as_ids(data.get("attachments") or [])[:MAX_PHOTOS]
                if content or photos:
                    msg = save_message_v2(
                        room, user, content, reply_to[0] if reply_to else None, owner_id=uid, attachment_ids=photos
                    )
                    if msg:
                        await hub.send(room, {"type": "message", "message": msg})
            elif kind == "edit":
                # Изменить можно только своё сообщение
                content = str(data.get("content", "")).strip()[:MAX_MESSAGE_LEN]
                found = get_message(as_ids(data.get("id"))[0]) if as_ids(data.get("id")) else None
                if content and found and found[0]["room"] == room and found[0]["username"] == user and not found[0]["sys"]:
                    conn = chat_conn()
                    conn.execute(
                        "UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?",
                        (content, found[0]["id"]),
                    )
                    conn.commit()
                    conn.close()
                    await hub.send(room, {"type": "update", "message": get_message(found[0]["id"])[1]})
            elif kind == "pin":
                found = get_message(as_ids(data.get("id"))[0]) if as_ids(data.get("id")) else None
                if found and found[0]["room"] == room and not found[0]["sys"]:
                    on = bool(data.get("pinned"))
                    conn = chat_conn()
                    conn.execute("UPDATE messages SET pinned = ? WHERE id = ?", (1 if on else 0, found[0]["id"]))
                    conn.commit()
                    conn.close()
                    await hub.send(room, {"type": "update", "message": get_message(found[0]["id"])[1]})
                    # Закрепили или открепили — в ленте появляется «X закрепил(а) / открепил(а) сообщение»
                    if on != bool(found[0]["pinned"]):
                        note = save_system_message(room, user, "pin" if on else "unpin", found[0]["id"])
                        await hub.send(room, {"type": "message", "message": note})
            elif kind == "delete":
                ids = as_ids(data.get("ids"))
                conn = chat_conn()
                marks = ",".join("?" * len(ids)) or "NULL"
                rows = conn.execute(
                    f"SELECT id, username FROM messages WHERE room = ? AND id IN ({marks})", (room, *ids)
                ).fetchall()
                if data.get("scope") == "all":
                    # У всех — только свои
                    mine = [r["id"] for r in rows if r["username"] == user]
                    if mine:
                        m2 = ",".join("?" * len(mine))
                        conn.execute(f"DELETE FROM messages WHERE id IN ({m2})", mine)
                        conn.execute(f"DELETE FROM message_hidden WHERE message_id IN ({m2})", mine)
                        orphans = drop_attachments(conn, f"message_id IN ({m2})", tuple(mine))
                        conn.commit()
                        purge_s3_keys(orphans)
                        await hub.send(room, {"type": "deleted", "ids": mine})
                else:
                    own = [r["id"] for r in rows]
                    conn.executemany(
                        "INSERT OR IGNORE INTO message_hidden (user_id, message_id) VALUES (?, ?)",
                        [(uid, i) for i in own],
                    )
                    conn.commit()
                    if own:
                        await hub.send_user(room, user, {"type": "deleted", "ids": own})
                conn.close()
            elif kind == "forward":
                # Пересылка в другой (или этот же) чат, где пользователь состоит
                target = str(data.get("to", ""))
                conn = db()
                allowed = member_channel(conn, uid, target)
                conn.close()
                ids = as_ids(data.get("ids"))
                if allowed and ids:
                    conn = chat_conn()
                    marks = ",".join("?" * len(ids))
                    rows = conn.execute(
                        f"SELECT id, username, content, timestamp, fwd_user, fwd_ts FROM messages WHERE room = ? AND id IN ({marks}) AND sys IS NULL ORDER BY id",
                        (room, *ids),
                    ).fetchall()
                    conn.close()
                    for r in rows:
                        msg = save_message_v2(
                            target,
                            user,
                            r["content"],
                            None,
                            r["fwd_user"] or r["username"],
                            r["fwd_ts"] or r["timestamp"],
                            copy_attachments_from=r["id"],
                        )
                        if msg:
                            await hub.send(target, {"type": "message", "message": msg})
                    await websocket.send_json({"type": "forwarded", "to": target, "count": len(rows)})
            elif kind == "read":
                ids = as_ids(data.get("id"))
                if ids:
                    conn = chat_conn()
                    top = conn.execute("SELECT MAX(id) FROM messages WHERE room = ?", (room,)).fetchone()[0] or 0
                    conn.close()
                    last = min(ids[0], top)
                    if last and mark_read(uid, room, last):
                        await hub.send(room, {"type": "read", "user": user, "id": last})
            elif kind == "typing":
                await hub.send(room, {"type": "typing", "user": user}, skip=websocket)
    except WebSocketDisconnect:
        pass
    finally:
        await hub.leave(websocket, room)


def server_json(conn, srv) -> dict:
    channels = conn.execute(
        "SELECT slug, name, kind, room FROM channels WHERE server_id = ? ORDER BY position, id", (srv["id"],)
    ).fetchall()
    return {
        "id": srv["id"],
        "short": srv["short"],
        "name": srv["name"],
        "about": srv["about"],
        "gradient": srv["gradient"],
        "channels": [{"id": c["slug"], "name": c["name"], "kind": c["kind"], "room": c["room"]} for c in channels],
    }


@app.get("/api/servers")
async def servers_list(request: Request):
    row = current_user(request)
    if not row:
        return unauthorized()
    conn = db()
    rows = conn.execute(
        "SELECT s.* FROM servers s JOIN server_members m ON m.server_id = s.id WHERE m.user_id = ? ORDER BY s.position, s.created_at",
        (row["id"],),
    ).fetchall()
    out = [server_json(conn, r) for r in rows]
    conn.close()
    return {"servers": out}


@app.get("/api/servers/{server_id}/members")
async def server_members(server_id: str, request: Request):
    row = current_user(request)
    if not row:
        return unauthorized()
    conn = db()
    if not member_server(conn, row["id"], server_id):
        conn.close()
        return JSONResponse({"error": "Вы не участник этого сервера"}, status_code=403)
    rows = conn.execute(
        "SELECT u.*, m.joined_at FROM server_members m JOIN users u ON u.id = m.user_id "
        "WHERE m.server_id = ? ORDER BY u.display_name COLLATE NOCASE",
        (server_id,),
    ).fetchall()
    conn.close()
    statuses = hub.statuses()
    return {
        "members": [
            {**public_user(r), "joinedAt": to_iso(r["joined_at"]), "status": statuses.get(r["username"], "offline")}
            for r in rows
        ]
    }


@app.put("/api/status")
async def status_update(request: Request):
    row = current_user(request)
    if not row:
        return unauthorized()
    data = await request.json()
    status = str(data.get("status", ""))
    if status not in STATUSES:
        return JSONResponse({"error": "Неизвестный статус"}, status_code=400)
    conn = db()
    conn.execute("UPDATE users SET status = ? WHERE id = ?", (status, row["id"]))
    conn.commit()
    conn.close()
    await hub.broadcast_presence()
    return {"status": status}


WEB_DIST = Path(os.getenv("WEB_DIST", Path(__file__).parent / "web" / "dist"))

class SpaStatic(StaticFiles):
    """Фронтенд с роутером: адреса страниц (/servers/…, /settings/…) отдают index.html,
    а дальше их разбирает сам интерфейс. Отсутствующие файлы (с расширением) и /api — по-прежнему 404."""

    async def get_response(self, path, scope):
        # Адрес страницы — без расширения в последнем сегменте и не /api
        page = not path.startswith("api") and "." not in path.rsplit("/", 1)[-1]
        try:
            resp = await super().get_response(path, scope)
        except HTTPException as e:
            if e.status_code == 404 and page:
                return await super().get_response("index.html", scope)
            raise
        # Есть свой 404.html — StaticFiles отдаёт его ответом, а не исключением
        if resp.status_code == 404 and page:
            return await super().get_response("index.html", scope)
        return resp


if WEB_DIST.is_dir():
    app.mount("/", SpaStatic(directory=WEB_DIST, html=True), name="web")
else:
    @app.get("/", response_class=HTMLResponse)
    async def get_index():
        with open("index.html", "r", encoding="utf-8") as f:
            return f.read()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
