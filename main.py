import uvicorn
import asyncio
import time
import sqlite3
import os
import json
import re
import urllib.parse
from pathlib import Path
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from livekit import api

app = FastAPI()


def load_env_file(path: Path) -> None:
    """Load .env when running without Docker (python main.py). Real environment variables win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file(Path(__file__).parent / ".env")

LK_SERVER_URL = os.getenv("LK_SERVER_URL", "ws://127.0.0.1:7880")
LK_API_URL = os.getenv("LK_API_URL", LK_SERVER_URL.replace("wss://", "https://").replace("ws://", "http://"))
LK_API_KEY = os.getenv("LK_API_KEY")
LK_API_SECRET = os.getenv("LK_API_SECRET")
DB_NAME = os.getenv("DB_NAME", "chat.db")
VOICE_ROOM_NAME = os.getenv("VOICE_ROOM_NAME", "Voice-Lounge")


def track_source(track) -> int:
    """LiveKit track source (protobuf enum, an int): 1 camera, 2 microphone, 3 screen."""
    try:
        return int(getattr(track, "source", 0) or 0)
    except (TypeError, ValueError):
        return 0


def live_tracks(participant, source: int) -> list:
    return [t for t in getattr(participant, "tracks", []) if track_source(t) == source]


def is_participant_muted(participant) -> bool:
    # No microphone track, or a muted one, means the microphone is off.
    mics = live_tracks(participant, 2)
    return not mics or all(getattr(t, "muted", False) for t in mics)


def has_live_track(participant, source: int) -> bool:
    return any(not getattr(t, "muted", False) for t in live_tracks(participant, source))


def is_participant_deafened(participant) -> bool:
    try:
        return bool(json.loads(participant.metadata or "{}").get("deafened"))
    except (ValueError, AttributeError):
        return False


def init_db():
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


init_db()


# Who is in a voice room, via the LiveKit API. Only used by /api/voice/participants.
async def get_room_participants(room_name: str):
    if not LK_API_KEY or not LK_API_SECRET:
        return JSONResponse({"participants": []})

    lk_api = None
    try:
        lk_api = api.LiveKitAPI(LK_API_URL, LK_API_KEY, LK_API_SECRET)
        results = await lk_api.room.list_participants(api.ListParticipantsRequest(room=room_name))

        participants = [
            {
                "identity": p.identity,
                "name": p.name or p.identity,
                "isMuted": is_participant_muted(p),
                "deafened": is_participant_deafened(p),
                "camera": has_live_track(p, 1),
                "screen": has_live_track(p, 3),
                # device type comes from the token attribute (phone icon next to the name)
                "mobile": p.attributes.get("device") == "mobile",
            }
            for p in results.participants
        ]
        return JSONResponse({"participants": participants})
    except Exception as e:
        print(f"Error fetching participants: {e}")
        return JSONResponse({"participants": []})
    finally:
        if lk_api:
            await lk_api.aclose()


# Admin endpoint: requires ADMIN_TOKEN (Authorization: Bearer <token>); disabled when ADMIN_TOKEN is empty.
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")


def admin_ok(request: Request) -> bool:
    import hmac

    auth = request.headers.get("authorization", "")
    given = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    return bool(ADMIN_TOKEN) and bool(given) and hmac.compare_digest(given.encode(), ADMIN_TOKEN.encode())


@app.delete("/clear_chat/{room_name}")
async def clear_chat(room_name: str, request: Request):
    if not ADMIN_TOKEN:
        return JSONResponse({"error": "not found"}, status_code=404)
    if not admin_ok(request):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    conn = sqlite3.connect(DB_NAME)
    ids = [r[0] for r in conn.execute("SELECT id FROM messages WHERE room = ?", (room_name,)).fetchall()]
    in_room = "message_id IN (SELECT id FROM messages WHERE room = ?)"
    # Photos and videos of these messages, from the DB and storage (unless a forwarded copy elsewhere still uses the file).
    orphans = drop_attachments(conn, in_room, (room_name,))
    conn.execute(f"DELETE FROM message_reactions WHERE {in_room}", (room_name,))
    conn.execute(f"DELETE FROM message_hidden WHERE {in_room}", (room_name,))
    conn.execute("DELETE FROM messages WHERE room = ?", (room_name,))
    conn.execute("DELETE FROM chat_reads WHERE room = ?", (room_name,))
    conn.execute("DELETE FROM chat_read_log WHERE room = ?", (room_name,))
    conn.commit()
    conn.close()
    purge_s3_keys(orphans)
    if ids:
        await hub.send(room_name, {"type": "deleted", "ids": ids})
    return {"ok": True, "messages": len(ids), "files": len(orphans)}


# Seed servers: each has its own #general, Lobby chat and voice room.
# "Ореол Гейминг" (rg) keeps unprefixed room names to preserve its old history.
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
# Zalgo text: hundreds of combining marks on one letter spill over the list. Keep at most two per character.
MAX_MARKS_PER_CHAR = 2


def clean_text(text: str) -> str:
    import unicodedata

    out = []
    marks = 0
    for ch in text:
        if unicodedata.category(ch) in ("Mn", "Me"):
            marks += 1
            if marks > MAX_MARKS_PER_CHAR:
                continue
        else:
            marks = 0
        out.append(ch)
    return "".join(out)


def to_iso(ts: str | None) -> str | None:
    # SQLite CURRENT_TIMESTAMP stores UTC as "YYYY-MM-DD HH:MM:SS".
    return ts.replace(" ", "T") + "Z" if ts else None


def init_chat_features():
    conn = sqlite3.connect(DB_NAME)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(messages)").fetchall()}
    for name, decl in (
        ("reply_to", "INTEGER"),
        ("edited_at", "DATETIME"),
        ("pinned", "INTEGER NOT NULL DEFAULT 0"),
        ("fwd_user", "TEXT"),
        ("fwd_ts", "DATETIME"),
        ("sys", "TEXT"),  # service row in the list: 'pin' / 'unpin', reply_to points at the message
    ):
        if name not in cols:
            conn.execute(f"ALTER TABLE messages ADD COLUMN {name} {decl}")
    # How far each user has read a room, for read receipts.
    conn.execute(
        """CREATE TABLE IF NOT EXISTS chat_reads (
            user_id INTEGER NOT NULL,
            room TEXT NOT NULL,
            last_id INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user_id, room)
        )"""
    )
    # When the mark moved, which tells who read a given message and when.
    conn.execute(
        """CREATE TABLE IF NOT EXISTS chat_read_log (
            user_id INTEGER NOT NULL,
            room TEXT NOT NULL,
            last_id INTEGER NOT NULL,
            at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS chat_read_log_room ON chat_read_log (room, last_id)")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS message_hidden (
            user_id INTEGER NOT NULL,
            message_id INTEGER NOT NULL,
            PRIMARY KEY (user_id, message_id)
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS message_reactions (
            message_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            emoji TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (message_id, username, emoji)
        )"""
    )
    conn.commit()
    conn.close()


init_chat_features()


# Attachments live in S3 (Timeweb Cloud) and are served through /api/media/<key>, so the bucket can stay private.
# Files are uploaded first (POST /api/attachments) and the message then references their ids.
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

MAX_PHOTO_BYTES = 10 * 1024 * 1024
MAX_VIDEO_BYTES = 50 * 1024 * 1024
MAX_PHOTO_SIDE = 8192
MAX_PHOTO_PIXELS = 40_000_000
MAX_PHOTO_RATIO = 16
MAX_GIF_SIDE = 2048
MAX_GIF_FRAME_PIXELS = 300_000_000
MIN_VIDEO_SIDE = 16
MAX_VIDEO_SIDE = 4096
MAX_VIDEO_RATIO = 4
MAX_PHOTOS = 10
STALE_UPLOAD_HOURS = 24  # uploaded but never sent: deleted after this
Image.MAX_IMAGE_PIXELS = MAX_PHOTO_PIXELS
# Format detected by Pillow -> (mime, ext). The Content-Type header is not trusted.
PHOTO_FORMATS = {"JPEG": ("image/jpeg", "jpg"), "PNG": ("image/png", "png"), "WEBP": ("image/webp", "webp"), "GIF": ("image/gif", "gif")}
MEDIA_KEY_RE = re.compile(r"^(?:photos/\d{4}/\d{2}/[0-9a-f]{32}\.(?:jpg|png|webp|gif|mp4|webm)|files/\d{4}/\d{2}/[0-9a-f]{32})$")
MAX_FILE_BYTES = MAX_VIDEO_BYTES
MAX_FILE_NAME = 180

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
    # original file name, only for documents (photos and videos have none)
    if "name" not in {r[1] for r in conn.execute("PRAGMA table_info(attachments)")}:
        conn.execute("ALTER TABLE attachments ADD COLUMN name TEXT")
    conn.commit()
    conn.close()


init_attachments_db()


def is_file_key(key: str) -> bool:
    return key.startswith("files/")


def clean_file_name(name: str) -> str:
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(ch for ch in name if ch.isprintable()).strip(" .")
    if len(name) > MAX_FILE_NAME:
        stem, dot, ext = name.rpartition(".")
        ext = ext[:16] if dot else ""
        name = (stem if dot else name)[: MAX_FILE_NAME - len(ext) - 1].rstrip() + ("." + ext if ext else "")
    return name or "file"


def media_url(key: str) -> str:
    return f"/api/media/{key}"


def attachments_of(conn, message_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT id, key, mime, width, height, name, size FROM attachments WHERE message_id = ? ORDER BY position, id",
        (message_id,),
    ).fetchall()
    return [att_json(a) for a in rows]


def att_json(a) -> dict:
    if is_file_key(a["key"]):
        return {"id": a["id"], "url": media_url(a["key"]), "w": 0, "h": 0, "file": True, "name": a["name"], "size": a["size"]}
    d = {"id": a["id"], "url": media_url(a["key"]), "w": a["width"], "h": a["height"]}
    if a["mime"].startswith("video/"):
        d["video"] = True
    return d


def purge_s3_keys(keys) -> None:
    """Deletes bucket objects in the background so the response does not wait for the network."""
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
    """Deletes attachment rows matching the condition and returns keys nobody references anymore
    (a forwarded message shares the original's file). The caller commits.
    """
    keys = [r[0] for r in conn.execute(f"SELECT DISTINCT key FROM attachments WHERE {where}", args).fetchall()]
    conn.execute(f"DELETE FROM attachments WHERE {where}", args)
    if not keys:
        return []
    marks = ",".join("?" * len(keys))
    still = {r[0] for r in conn.execute(f"SELECT DISTINCT key FROM attachments WHERE key IN ({marks})", keys).fetchall()}
    return [k for k in keys if k not in still]


def photo_info(body: bytes):
    """(mime, ext, width, height) or an error message. Size as the browser displays it (EXIF rotation applied)."""
    try:
        with Image.open(io.BytesIO(body)) as img:
            fmt = PHOTO_FORMATS.get(img.format or "")
            if not fmt:
                return "Поддерживаются JPG, PNG, WEBP и GIF"
            w, h = img.size
            frames = getattr(img, "n_frames", 1) if img.format == "GIF" else 1
            try:
                if img.getexif().get(0x0112) in (5, 6, 7, 8):  # rotated by 90 degrees: sides swap
                    w, h = h, w
            except Exception:
                pass
    except Image.DecompressionBombError:
        return f"Слишком большое разрешение, максимум {MAX_PHOTO_PIXELS // 1_000_000} Мп"
    except (UnidentifiedImageError, OSError, ValueError):
        return "Файл не похож на изображение"
    if min(w, h) < 1:
        return "Пустое изображение"
    if max(w, h) > MAX_PHOTO_SIDE or w * h > MAX_PHOTO_PIXELS:
        return f"Слишком большое разрешение: до {MAX_PHOTO_SIDE} px по стороне и {MAX_PHOTO_PIXELS // 1_000_000} Мп"
    if max(w, h) > MAX_PHOTO_RATIO * min(w, h):
        return f"Слишком вытянутое изображение: стороны должны отличаться не больше чем в {MAX_PHOTO_RATIO} раз"
    if fmt[1] == "gif":
        if max(w, h) > MAX_GIF_SIDE:
            return f"GIF больше {MAX_GIF_SIDE} px по стороне"
        if w * h * frames > MAX_GIF_FRAME_PIXELS:
            return "В GIF слишком много кадров для такого размера"
    return (*fmt, w, h)


def mp4_size(body: bytes) -> tuple[int, int] | None:

    def boxes(start: int, end: int):
        while start + 8 <= end:
            size = int.from_bytes(body[start : start + 4], "big")
            kind = body[start + 4 : start + 8]
            head = 8
            if size == 1:
                size = int.from_bytes(body[start + 8 : start + 16], "big")
                head = 16
            elif size == 0:
                size = end - start
            if size < head or start + size > end:
                return
            yield kind, start + head, start + size
            start += size

    for kind, a, b in boxes(0, len(body)):
        if kind != b"moov":
            continue
        for kind, ta, tb in boxes(a, b):
            if kind != b"trak":
                continue
            for kind, ha, hb in boxes(ta, tb):
                if kind != b"tkhd":
                    continue
                base = ha + (36 if body[ha] == 1 else 24)
                if hb - base < 60:
                    continue
                w = int.from_bytes(body[base + 52 : base + 56], "big") >> 16
                h = int.from_bytes(body[base + 56 : base + 60], "big") >> 16
                if w and h:
                    rotated = int.from_bytes(body[base + 16 : base + 20], "big") == 0
                    return (h, w) if rotated else (w, h)
    return None


def webm_size(body: bytes) -> tuple[int, int] | None:

    def vint(pos: int, keep_marker: bool):
        if pos >= len(body) or not body[pos]:
            return None, pos
        first = body[pos]
        n = 9 - first.bit_length()
        value = first if keep_marker else first & (0xFF >> n)
        for i in range(1, n):
            if pos + i >= len(body):
                return None, pos
            value = (value << 8) | body[pos + i]
        if not keep_marker and value == (1 << (7 * n)) - 1:
            value = -1
        return value, pos + n

    def walk(start: int, end: int):
        pos = start
        while pos < end:
            eid, p = vint(pos, True)
            if eid is None:
                return
            size, p = vint(p, False)
            if size is None:
                return
            stop = end if size < 0 else min(end, p + size)
            yield eid, p, stop
            pos = stop

    path = [0x18538067, 0x1654AE6B, 0xAE, 0xE0]

    def find(start: int, end: int, depth: int):
        for eid, a, b in walk(start, end):
            if eid == 0x1F43B675:
                return None
            if eid != path[depth]:
                continue
            if depth < len(path) - 1:
                got = find(a, b, depth + 1)
                if got:
                    return got
                continue
            dims = {vid: int.from_bytes(body[va:vb], "big") for vid, va, vb in walk(a, b) if vid in (0xB0, 0xBA)}
            if dims.get(0xB0) and dims.get(0xBA):
                return dims[0xB0], dims[0xBA]
        return None

    return find(0, len(body), 0)


def video_info(body: bytes, w: int, h: int):
    if body[:4] == bytes.fromhex("1a45dfa3"):
        mime, ext = "video/webm", "webm"
        size = webm_size(body)
    elif body[4:8] == b"ftyp":
        mime, ext = "video/mp4", "mp4"
        size = mp4_size(body)
    else:
        return None
    w, h = size or (w or 16, h or 9)
    if min(w, h) < MIN_VIDEO_SIDE:
        return "Слишком маленькое видео"
    if max(w, h) > MAX_VIDEO_SIDE:
        return f"Видео больше {MAX_VIDEO_SIDE} px по стороне"
    if max(w, h) > MAX_VIDEO_RATIO * min(w, h):
        return f"Слишком вытянутое видео: стороны должны отличаться не больше чем в {MAX_VIDEO_RATIO} раз"
    return mime, ext, w, h


def purge_stale_uploads():
    conn = sqlite3.connect(DB_NAME)
    keys = drop_attachments(
        conn, "message_id IS NULL AND created_at < datetime('now', ?)", (f"-{STALE_UPLOAD_HOURS} hours",)
    )
    conn.commit()
    conn.close()
    purge_s3_keys(keys)


@app.post("/api/attachments")
async def attachment_upload(request: Request):
    row = current_user(request)
    if not row:
        return unauthorized()
    if not S3_ACCESS_KEY or not S3_SECRET_KEY:
        return JSONResponse({"error": "Хранилище файлов не настроено на сервере"}, status_code=503)
    mb = lambda n: n // (1024 * 1024)  # noqa: E731
    too_big = JSONResponse({"error": f"Файл больше {mb(MAX_VIDEO_BYTES)} МБ"}, status_code=413)
    try:
        if int(request.headers.get("content-length") or 0) > MAX_VIDEO_BYTES:
            return too_big
    except ValueError:
        pass
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_VIDEO_BYTES:
            return too_big
    if not body:
        return JSONResponse({"error": "Пустой файл"}, status_code=400)
    body = bytes(body)

    def num(name):
        try:
            return int(request.query_params.get(name) or 0)
        except ValueError:
            return 0

    raw_name = request.query_params.get("name")
    if raw_name is not None:
        return await store_file(row, body, clean_file_name(raw_name))

    info = video_info(body, num("w"), num("h"))
    if isinstance(info, str):
        return JSONResponse({"error": info}, status_code=415)
    if not info:
        if len(body) > MAX_PHOTO_BYTES:
            return JSONResponse({"error": f"Фото больше {mb(MAX_PHOTO_BYTES)} МБ"}, status_code=413)
        info = await asyncio.to_thread(photo_info, body)
        if isinstance(info, str):
            return JSONResponse({"error": info.replace("Поддерживаются JPG, PNG, WEBP и GIF", "Поддерживаются JPG, PNG, WEBP, GIF, MP4, MOV и WEBM")}, status_code=415)
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
    return att_json({"id": cur.lastrowid, "key": key, "mime": mime, "width": w, "height": h})


async def store_file(row, body: bytes, name: str):
    now = datetime.now(timezone.utc)
    key = f"files/{now:%Y}/{now:%m}/{uuid.uuid4().hex}"
    try:
        await asyncio.to_thread(
            s3().put_object,
            Bucket=S3_BUCKET,
            Key=key,
            Body=body,
            ContentType="application/octet-stream",
            CacheControl="private, max-age=31536000, immutable",
        )
    except (BotoCoreError, ClientError) as e:
        print(f"s3 upload: {e}")
        return JSONResponse({"error": "Не удалось сохранить файл, попробуйте ещё раз"}, status_code=502)
    conn = db()
    cur = conn.execute(
        "INSERT INTO attachments (user_id, key, mime, width, height, size, name) VALUES (?, ?, ?, 0, 0, ?, ?)",
        (row["id"], key, "application/octet-stream", len(body), name),
    )
    conn.commit()
    conn.close()
    asyncio.create_task(asyncio.to_thread(purge_stale_uploads))
    return att_json({"id": cur.lastrowid, "key": key, "mime": "application/octet-stream", "width": 0, "height": 0, "name": name, "size": len(body)})


def download_disposition(name: str) -> str:
    ascii_name = "".join(ch if 32 <= ord(ch) < 127 and ch not in '"\\;' else "_" for ch in name)
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{urllib.parse.quote(name, safe='')}"


@app.delete("/api/attachments/{att_id}")
async def attachment_cancel(att_id: int, request: Request):
    row = current_user(request)
    if not row:
        return unauthorized()
    conn = db()
    keys = drop_attachments(conn, "id = ? AND user_id = ? AND message_id IS NULL", (att_id, row["id"]))
    conn.commit()
    conn.close()
    purge_s3_keys(keys)
    return {"ok": True}


RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


@app.get("/api/media/{key:path}")
async def media(key: str, request: Request):
    # Only keys recorded in the DB: this route must not expose arbitrary bucket objects.
    if not MEDIA_KEY_RE.match(key):
        return JSONResponse({"error": "not found"}, status_code=404)
    conn = db()
    att = conn.execute("SELECT mime, name FROM attachments WHERE key = ? LIMIT 1", (key,)).fetchone()
    conn.close()
    if not att or not S3_ACCESS_KEY:
        return JSONResponse({"error": "not found"}, status_code=404)
    # Browsers (Safari especially) read video in Range chunks and will not play without it.
    rng = RANGE_RE.match(request.headers.get("range", "").strip())
    if rng and not (rng[1] or rng[2]):
        rng = None
    get = {"Bucket": S3_BUCKET, "Key": key}
    if rng:
        get["Range"] = f"bytes={rng[1]}-{rng[2]}"
    try:
        obj = await asyncio.to_thread(lambda: s3().get_object(**get))
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("NoSuchKey", "404"):
            return JSONResponse({"error": "not found"}, status_code=404)
        if code == "InvalidRange":
            return Response(status_code=416)
        print(f"s3 get: {e}")
        return Response(status_code=502)
    except BotoCoreError as e:
        print(f"s3 get: {e}")
        return Response(status_code=502)
    headers = {"Cache-Control": "public, max-age=31536000, immutable", "Accept-Ranges": "bytes"}
    if is_file_key(key):
        # documents always download: an uploaded HTML or SVG must never render on our origin
        headers["Content-Disposition"] = download_disposition(att["name"] or "file")
        headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
        headers["Cache-Control"] = "private, max-age=31536000, immutable"
    if obj.get("ContentLength") is not None:
        headers["Content-Length"] = str(obj["ContentLength"])
    status = 200
    if rng and obj.get("ContentRange"):
        headers["Content-Range"] = obj["ContentRange"]
        status = 206
    # The body is read in chunks in a thread pool, large files are never held in memory whole.
    return StreamingResponse(obj["Body"].iter_chunks(64 * 1024), status_code=status, media_type=att["mime"], headers=headers)


MSG_COLS = "id, room, username, content, timestamp, reply_to, edited_at, pinned, fwd_user, fwd_ts, sys"


def reply_text(conn, q) -> str:
    if q["content"]:
        return q["content"][:200]
    n, v, f, name = conn.execute(
        "SELECT COUNT(*), SUM(mime LIKE 'video/%'), SUM(key LIKE 'files/%'), MAX(name) FROM attachments WHERE message_id = ?",
        (q["id"],),
    ).fetchone()
    if not n:
        return ""
    if f == n:
        return name if n == 1 and name else f"Файлы · {n}"
    label = "Видео" if v == n else "Фото" if not v and not f else "Вложения"
    return label if n == 1 else f"{label} · {n}"


def first_photo(conn, message_id: int) -> str | None:
    a = conn.execute(
        "SELECT key FROM attachments WHERE message_id = ? AND mime LIKE 'image/%' ORDER BY position, id LIMIT 1",
        (message_id,),
    ).fetchone()
    return media_url(a[0]) if a else None


REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "👎", "🤡", "🎉", "🙏"]
MAX_REACTIONS_PER_USER = 3  # distinct reactions per user per message


def reactions_of(conn, message_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT emoji, username FROM message_reactions WHERE message_id = ? ORDER BY created_at, rowid", (message_id,)
    ).fetchall()
    out: dict[str, list[str]] = {}
    for e, u in rows:
        out.setdefault(e, []).append(u)
    return [{"e": e, "users": us} for e, us in out.items()]


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
        "reactions": reactions_of(conn, r["id"]),
        "replies": conn.execute(
            "SELECT COUNT(*) FROM messages WHERE reply_to = ? AND sys IS NULL", (r["id"],)
        ).fetchone()[0],
    }


def chat_conn():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn


def get_history_v2(room: str, limit: int = 100, user_id: int | None = None, before: int | None = None):
    """The last `limit` messages of a room; `before` pages older history."""
    conn = chat_conn()
    hidden = "AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)" if user_id else ""
    older = "AND id < ?" if before else ""
    args = [room]
    if user_id:
        args.append(user_id)
    if before:
        args.append(before)
    args.append(limit)
    rows = conn.execute(
        f"SELECT {MSG_COLS} FROM messages WHERE room = ? {hidden} {older} ORDER BY id DESC LIMIT ?", args
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
    """attachment_ids: the owner's uploaded, unsent files. copy_attachments_from: forwarding reuses the original's files.
    An empty message without attachments is not saved and None is returned.
    """
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
        ids = [i for i in wanted if i in free]
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
            "INSERT INTO attachments (message_id, user_id, key, mime, width, height, size, position, name) "
            "SELECT ?, user_id, key, mime, width, height, size, position, name FROM attachments WHERE message_id = ?",
            (cur.lastrowid, copy_attachments_from),
        )
    conn.commit()
    r = conn.execute(f"SELECT {MSG_COLS} FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone()
    out = msg_json(conn, r)
    conn.close()
    return out


def get_reads(room: str) -> dict:
    conn = chat_conn()
    rows = conn.execute(
        "SELECT u.username, r.last_id FROM chat_reads r JOIN users u ON u.id = r.user_id WHERE r.room = ?", (room,)
    ).fetchall()
    conn.close()
    return {r["username"]: r["last_id"] for r in rows}


def mark_read(user_id: int, room: str, last_id: int) -> bool:
    """Moves the mark forward only. True if it changed."""
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
    conn.execute("INSERT INTO chat_read_log (user_id, room, last_id) VALUES (?, ?, ?)", (user_id, room, last_id))
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


# Names that cannot be taken: @everyone and @here ping the whole chat, the rest impersonate the system.
RESERVED_NAMES = {"everyone", "here", "all", "channel", "admin", "administrator", "moderator", "system", "oreol", "support"}
RESERVED_MSG = "Это имя зарезервировано, выберите другое"


def reserved_name(name: str) -> bool:
    return re.sub(r"[^a-z0-9]", "", name.lower()) in RESERVED_NAMES


def clean_name(value: str) -> str:
    name = " ".join((value or "").split())[:MAX_NAME_LEN]
    return name if NAME_RE.match(name) else ""


# Accounts: email + password, no email confirmation. Passwords use stdlib scrypt, sessions are random tokens
# in the sessions table. Avatars and banners are files in UPLOADS_DIR served from /api/uploads/.
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
    # sessions expire by last use
    cols = {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
    if "last_used" not in cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN last_used DATETIME")
    conn.commit()
    conn.close()


init_auth_db()

# A session lives 30 days after its last use: active users stay signed in, a stolen and abandoned token dies.
SESSION_DAYS = 30

# Servers, channels and members live in the DB; below is only the initial seed. Every registered user
# automatically joins servers with auto_join=1.
STATUSES = ("online", "idle", "dnd", "offline")  # offline means invisible
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
    if "last_seen" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN last_seen DATETIME")
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
    # Existing users join every auto_join server (dated by their registration).
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
    return conn.execute(
        "SELECT s.* FROM servers s JOIN server_members m ON m.server_id = s.id WHERE s.id = ? AND m.user_id = ?",
        (server_id, user_id),
    ).fetchone()


def member_channel(conn, user_id: int, room: str):
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
        # invisible users keep their last visit hidden as well
        "lastSeen": to_iso(row["last_seen"]) if row["status"] != "offline" else None,
    }


def me_user(row) -> dict:
    return {**public_user(row), "id": row["id"], "email": row["email"], "phone": row["phone"], "status": row["status"]}


def new_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    conn = db()
    conn.execute("INSERT INTO sessions (token, user_id, last_used) VALUES (?, ?, CURRENT_TIMESTAMP)", (token, user_id))
    conn.execute(
        "DELETE FROM sessions WHERE COALESCE(last_used, created_at) < datetime('now', ?)", (f"-{SESSION_DAYS} days",)
    )
    conn.commit()
    conn.close()
    return token


def user_by_token(token: str | None):
    if not token:
        return None
    conn = db()
    row = conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ? AND COALESCE(s.last_used, s.created_at) >= datetime('now', ?)",
        (token, f"-{SESSION_DAYS} days"),
    ).fetchone()
    if row:
        # bump last_used at most hourly so not every request writes to the DB
        conn.execute(
            "UPDATE sessions SET last_used = CURRENT_TIMESTAMP WHERE token = ? "
            "AND (last_used IS NULL OR last_used < datetime('now', '-1 hour'))",
            (token,),
        )
        conn.commit()
    conn.close()
    return row


SESSION_COOKIE = "oreol_session"


def bearer(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else None


def session_token(request) -> str | None:
    # HttpOnly cookie is the primary carrier; Bearer stays for migrating old clients and scripts
    return request.cookies.get(SESSION_COOKIE) or bearer(request)


def current_user(request: Request):
    return user_by_token(session_token(request))


def set_session_cookie(resp, token: str, request: Request):
    https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    resp.set_cookie(
        SESSION_COOKIE, token, max_age=SESSION_DAYS * 86400, path="/", httponly=True, secure=https, samesite="lax"
    )
    return resp


def same_origin(headers) -> bool:
    """Cookie auth needs a CSRF guard: SameSite=Lax still lets sibling subdomains through."""
    site = headers.get("sec-fetch-site")
    if site:
        return site in ("same-origin", "none")
    origin = headers.get("origin")
    if not origin:
        return True
    return urllib.parse.urlsplit(origin).netloc == headers.get("host", "")


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
    elif reserved_name(username):
        errors["username"] = RESERVED_MSG
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
    return set_session_cookie(JSONResponse({"user": me_user(row)}), new_session(user_id), request)


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
    return set_session_cookie(JSONResponse({"user": me_user(row)}), new_session(row["id"]), request)


@app.get("/api/auth/me")
async def auth_me(request: Request):
    token = session_token(request)
    row = user_by_token(token)
    if not row:
        resp = unauthorized()
        resp.delete_cookie(SESSION_COOKIE, path="/")
        return resp
    # refreshing the cookie keeps active users signed in and moves old localStorage tokens into the cookie
    return set_session_cookie(JSONResponse({"user": me_user(row)}), token, request)


@app.post("/api/auth/logout")
async def auth_logout(request: Request):
    token = session_token(request)
    if token:
        conn = db()
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
        conn.close()
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


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
        values.append(clean_text(str(data["bio"])).strip()[:MAX_BIO_LEN])
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


# Avatars are cropped to a circle and banners to a wide strip, so extreme shapes would just be cut away
PROFILE_IMAGE = {
    "avatars": {"min": (64, 64), "max_side": 2048, "ratio": (0.5, 2.0)},
    "banners": {"min": (300, 75), "max_side": 4096, "ratio": (1.5, 6.0)},
}
MAX_PROFILE_GIF_FRAMES = 300


def profile_image_problem(kind: str, size: tuple[int, int], frames: int) -> str | None:
    rule = PROFILE_IMAGE[kind]
    w, h = size
    what = "Аватар" if kind == "avatars" else "Баннер"
    if w < rule["min"][0] or h < rule["min"][1]:
        return f"{what} слишком маленький: нужно минимум {rule['min'][0]}×{rule['min'][1]} px"
    if max(w, h) > rule["max_side"]:
        return f"{what} больше {rule['max_side']} px по стороне"
    lo, hi = rule["ratio"]
    if not lo <= w / h <= hi:
        shape = "почти квадратная картинка, стороны до 1:2" if kind == "avatars" else "широкая картинка, от 3:2 до 6:1"
        return f"Для {'аватара' if kind == 'avatars' else 'баннера'} нужна {shape}"
    if frames > MAX_PROFILE_GIF_FRAMES:
        return f"В GIF больше {MAX_PROFILE_GIF_FRAMES} кадров"
    return None


async def save_image(request: Request, kind: str):
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
    # format from the content, not the header, so HTML or scripts cannot pass as an image
    try:
        with Image.open(io.BytesIO(body)) as im:
            fmt, size = im.format, im.size
            frames = getattr(im, "n_frames", 1)
            im.verify()
    except Exception:
        return JSONResponse({"error": "Файл повреждён или это не картинка"}, status_code=415)
    ext = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp", "GIF": "gif"}.get(fmt or "")
    if not ext:
        return JSONResponse({"error": "Поддерживаются PNG, JPG, WEBP и GIF"}, status_code=415)
    problem = profile_image_problem(kind, size, frames)
    if problem:
        return JSONResponse({"error": problem}, status_code=415)
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


def clean_phone(value: str) -> str | None:
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
            if reserved_name(username):
                errors["username"] = RESERVED_MSG
            else:
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
        if "username" in updates:
            conn.execute("UPDATE messages SET username = ? WHERE username = ?", (updates["username"], row["username"]))
            conn.execute("UPDATE OR IGNORE message_reactions SET username = ? WHERE username = ?", (updates["username"], row["username"]))
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
    # sign out every other session
    conn.execute("DELETE FROM sessions WHERE user_id = ? AND token != ?", (row["id"], session_token(request)))
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
    orphans = drop_attachments(
        conn,
        "message_id IN (SELECT id FROM messages WHERE username = ?) OR (message_id IS NULL AND user_id = ?)",
        (row["username"], row["id"]),
    )
    conn.execute("DELETE FROM messages WHERE username = ?", (row["username"],))
    conn.execute("DELETE FROM message_reactions WHERE username = ?", (row["username"],))
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
        can_update_own_metadata=True,  # the "deafened" flag travels in participant metadata
    )
    token = (
        api.AccessToken(LK_API_KEY, LK_API_SECRET)
        .with_identity(username)
        .with_name(username)
        .with_grants(grant)
        .with_attributes({"device": "mobile" if data.get("device") == "mobile" else "desktop"})
        .to_jwt()
    )
    VOICE_TOKEN_AT[username] = time.time()
    return {"token": token, "url": LK_SERVER_URL, "room": room}


# Tab closed while in voice. The client sends no "leave" on unload (so a reload keeps you in the channel),
# and LiveKit keeps a dropped participant for a long time. The page sends a beacon instead, and if the same user
# does not reconnect within VOICE_LEAVE_GRACE seconds they are removed from the room.
VOICE_LEAVE_GRACE = 15
VOICE_TOKEN_AT: dict[str, float] = {}


async def drop_voice_later(username: str, room: str, since: float):
    await asyncio.sleep(VOICE_LEAVE_GRACE)
    if VOICE_TOKEN_AT.get(username, 0) > since:
        return  # reloaded: already back
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
    """Beacon from the page (navigator.sendBeacon): no custom headers; the cookie authenticates, older builds put the token in the body."""
    if not LK_API_KEY or not LK_API_SECRET:
        return {"ok": False}
    try:
        data = json.loads((await request.body()) or b"{}")
    except ValueError:
        return JSONResponse({"error": "bad body"}, status_code=400)
    row = current_user(request) or user_by_token(str(data.get("auth") or ""))
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
async def api_voice_participants(request: Request, server: str = "rg"):
    row = current_user(request)
    if not row:
        return unauthorized()
    conn = db()
    srv = member_server(conn, row["id"], server)
    conn.close()
    if not srv:
        return JSONResponse({"error": "unknown server"}, status_code=400)
    return await get_room_participants(srv["voice_room"])


class ChatHub:

    # A user whose last socket closed stays online this long: switching channels reopens the socket at once.
    OFFLINE_GRACE = 8.0

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
        user = next((n for w, n in self.rooms.get(room, []) if w is ws), None)
        self.rooms[room] = [(w, n) for w, n in self.rooms.get(room, []) if w is not ws]
        if not self.rooms[room]:
            del self.rooms[room]
        if user and user not in self.all_users():
            asyncio.create_task(self.went_offline(user))

    async def went_offline(self, user: str):
        await asyncio.sleep(self.OFFLINE_GRACE)
        if user in self.all_users():
            return
        conn = db()
        conn.execute("UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE username = ? AND status != 'offline'", (user,))
        conn.commit()
        conn.close()
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
        """Visible status of each connected user. Invisible users are left out, everyone sees them offline."""
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
    if not same_origin(websocket.headers):
        await websocket.close(code=4403)
        return
    await websocket.accept()
    # the cookie arrives with the handshake; tabs opened before the cookie switch send {"type":"auth"} first
    token = websocket.cookies.get(SESSION_COOKIE) or websocket.query_params.get("token")
    if not token:
        try:
            first = json.loads(await asyncio.wait_for(websocket.receive_text(), timeout=10))
            token = first.get("token") if isinstance(first, dict) and first.get("type") == "auth" else None
        except (asyncio.TimeoutError, WebSocketDisconnect, ValueError):
            token = None
    row = user_by_token(token if isinstance(token, str) else None)
    user = row["username"] if row else ""
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
                content = clean_text(str(data.get("content", ""))).strip()[:MAX_MESSAGE_LEN]
                reply_to = as_ids(data.get("reply_to"))[:1] if data.get("reply_to") is not None else []
                photos = as_ids(data.get("attachments") or [])[:MAX_PHOTOS]
                if content or photos:
                    msg = save_message_v2(
                        room, user, content, reply_to[0] if reply_to else None, owner_id=uid, attachment_ids=photos
                    )
                    if msg:
                        await hub.send(room, {"type": "message", "message": msg})
            elif kind == "edit":
                content = clean_text(str(data.get("content", ""))).strip()[:MAX_MESSAGE_LEN]
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
            elif kind == "react":
                emoji = str(data.get("emoji", ""))
                found = get_message(as_ids(data.get("id"))[0]) if as_ids(data.get("id")) else None
                if emoji in REACTIONS and found and found[0]["room"] == room and not found[0]["sys"]:
                    mid = found[0]["id"]
                    conn = chat_conn()
                    had = conn.execute(
                        "SELECT 1 FROM message_reactions WHERE message_id = ? AND username = ? AND emoji = ?", (mid, user, emoji)
                    ).fetchone()
                    if had:
                        conn.execute(
                            "DELETE FROM message_reactions WHERE message_id = ? AND username = ? AND emoji = ?", (mid, user, emoji)
                        )
                    else:
                        mine = conn.execute(
                            "SELECT emoji FROM message_reactions WHERE message_id = ? AND username = ? ORDER BY created_at, rowid",
                            (mid, user),
                        ).fetchall()
                        # at the limit the user's oldest reaction makes room for the new one
                        for (old,) in mine[: max(0, len(mine) - MAX_REACTIONS_PER_USER + 1)]:
                            conn.execute(
                                "DELETE FROM message_reactions WHERE message_id = ? AND username = ? AND emoji = ?", (mid, user, old)
                            )
                        conn.execute("INSERT INTO message_reactions (message_id, username, emoji) VALUES (?, ?, ?)", (mid, user, emoji))
                    conn.commit()
                    reactions = reactions_of(conn, mid)
                    conn.close()
                    await hub.send(room, {"type": "reactions", "id": mid, "reactions": reactions})
            elif kind == "pin":
                found = get_message(as_ids(data.get("id"))[0]) if as_ids(data.get("id")) else None
                if found and found[0]["room"] == room and not found[0]["sys"]:
                    on = bool(data.get("pinned"))
                    conn = chat_conn()
                    conn.execute("UPDATE messages SET pinned = ? WHERE id = ?", (1 if on else 0, found[0]["id"]))
                    conn.commit()
                    conn.close()
                    await hub.send(room, {"type": "update", "message": get_message(found[0]["id"])[1]})
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
                    mine = [r["id"] for r in rows if r["username"] == user]
                    if mine:
                        m2 = ",".join("?" * len(mine))
                        conn.execute(f"DELETE FROM messages WHERE id IN ({m2})", mine)
                        conn.execute(f"DELETE FROM message_hidden WHERE message_id IN ({m2})", mine)
                        conn.execute(f"DELETE FROM message_reactions WHERE message_id IN ({m2})", mine)
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
            elif kind == "voice":
                # someone joined or left voice: everyone refreshes the roster now instead of waiting for the poll
                await hub.broadcast_all({"type": "voice", "user": user})
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


@app.get("/api/unread")
async def unread_counts(request: Request):
    """Unread messages per server for the rail badges: others' messages past the user's read mark."""
    row = current_user(request)
    if not row:
        return unauthorized()
    conn = db()
    rooms = conn.execute(
        "SELECT c.server_id, c.room FROM channels c JOIN server_members m ON m.server_id = c.server_id WHERE m.user_id = ?",
        (row["id"],),
    ).fetchall()
    conn.close()
    out: dict[str, dict] = {}
    me = row["username"]
    mention = f"%@{me}%"
    conn = chat_conn()
    for r in rooms:
        got = conn.execute(
            "SELECT COUNT(*) AS n, SUM(content LIKE ? OR content LIKE '%@everyone%') AS at FROM messages "
            "WHERE room = ? AND sys IS NULL AND username != ? "
            "AND id > COALESCE((SELECT last_id FROM chat_reads WHERE user_id = ? AND room = ?), 0) "
            "AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)",
            (mention, r["room"], me, row["id"], r["room"], row["id"]),
        ).fetchone()
        cur = out.setdefault(r["server_id"], {"count": 0, "mentions": 0})
        cur["count"] += got["n"] or 0
        cur["mentions"] += got["at"] or 0
    conn.close()
    return {"servers": out}


# Link previews (Open Graph). The server fetches the link itself, so only the public internet is allowed:
# private, loopback and reserved ranges are rejected, on every redirect too.
import base64
import codecs
import html as html_lib
import ipaddress
import socket
import http.client
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

LINK_MAX_BYTES = 2 * 1024 * 1024  # YouTube puts ~850 KB of inline scripts before its og: tags
GIF_SITES = ("tenor.com", "giphy.com")
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
LINK_TIMEOUT = 5
LINK_CACHE_SEC = 3600
LINK_FAIL_CACHE_SEC = 120
LINK_CACHE_MAX = 500
_link_cache: dict[str, tuple[float, dict | None]] = {}


def public_url(url: str) -> bool:
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password:
        return False
    try:
        port = u.port or (443 if u.scheme == "https" else 80)
    except ValueError:
        return False
    if port not in (80, 443, 8080, 8443):
        return False
    try:
        infos = socket.getaddrinfo(u.hostname, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        return False
    return bool(infos) and all(ipaddress.ip_address(i[4][0].split("%")[0]).is_global for i in infos)


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 4

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not public_url(newurl):
            raise urllib.error.URLError("redirect to a private address")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# Check and connect using the same DNS answer. Otherwise a short-TTL site could resolve to a public IP
# for the check and to 127.0.0.1 for the connection (DNS rebinding).
def _public_socket(host: str, port: int, timeout) -> socket.socket:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not infos or not all(ipaddress.ip_address(i[4][0].split("%")[0]).is_global for i in infos):
        raise OSError("private address")
    err: OSError | None = None
    for fam, typ, proto, _, addr in infos:
        sock = socket.socket(fam, typ, proto)
        sock.settimeout(timeout if isinstance(timeout, (int, float)) else LINK_TIMEOUT)
        try:
            sock.connect(addr)
            return sock
        except OSError as e:
            err = e
            sock.close()
    raise err or OSError("no address")


class _PublicHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = _public_socket(self.host, self.port, self.timeout)


class _PublicHTTPS(http.client.HTTPSConnection):
    def connect(self):
        sock = _public_socket(self.host, self.port, self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _PublicHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_PublicHTTP, req)


class _PublicHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_PublicHTTPS, req, context=self._context)


# no system proxies: connect straight to the verified address
_link_opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), _PublicHTTPHandler, _PublicHTTPSHandler, _SafeRedirect
)


class _MetaParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title = ""
        self.icon = ""
        self._in_title = False
        self.done = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key and "content" in a and key not in self.meta:
                self.meta[key] = a["content"]
        elif tag == "title":
            self._in_title = True
        elif tag == "link" and not self.icon and "icon" in a.get("rel", "").lower().split():
            self.icon = a.get("href", "")
        elif tag == "body":
            self.done = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "head":
            self.done = True

    def handle_data(self, data):
        if self._in_title and len(self.title) < 300:
            self.title += data


def _clip(s: str, n: int) -> str:
    s = " ".join(html_lib.unescape(s or "").split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,20}$")
# YouTube's own oEmbed first; noembed.com mirrors it for networks where youtube.com does not resolve
YOUTUBE_OEMBED = ("https://www.youtube.com/oembed?format=json&url=", "https://noembed.com/embed?url=")


def youtube_id(url: str) -> str | None:
    u = urllib.parse.urlsplit(url)
    host = (u.hostname or "").lower()
    parts = [p for p in u.path.split("/") if p]
    if host == "youtu.be":
        vid = parts[0] if parts else ""
    elif parts[:1] == ["watch"]:
        vid = (urllib.parse.parse_qs(u.query).get("v") or [""])[0]
    elif len(parts) >= 2 and parts[0] in ("shorts", "live", "embed"):
        vid = parts[1]
    else:
        return None
    return vid if YOUTUBE_ID_RE.match(vid) else None


def youtube_preview(url: str) -> dict | None:
    """oEmbed is small and stable, unlike the 1.5 MB watch page. The video URL itself is never fetched."""
    vid = youtube_id(url)
    if not vid:
        return None
    canonical = "https://www.youtube.com/watch?v=" + vid
    data = None
    for base in YOUTUBE_OEMBED:
        req = urllib.request.Request(
            base + urllib.parse.quote(canonical, safe=""),
            headers={"User-Agent": "Mozilla/5.0 (compatible; OreolBot/1.0; link preview)"},
        )
        try:
            with _link_opener.open(req, timeout=LINK_TIMEOUT) as r:
                data = json.loads(r.read(64 * 1024))
        except Exception:
            continue
        if isinstance(data, dict) and data.get("title"):
            break
        data = None
    if not data:
        return None
    title = _clip(str(data.get("title") or ""), 160)
    image = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    return {
        "url": url,
        "title": title,
        "description": _clip(str(data.get("author_name") or ""), 300),
        "image": link_image_path(image) if image.startswith("https://") else None,
        "site": "YouTube",
    }


def gif_site(host: str) -> bool:
    return any(host == d or host.endswith("." + d) for d in GIF_SITES)


def _int(v) -> int | None:
    try:
        n = int(str(v).strip())
    except (TypeError, ValueError):
        return None
    return n if 0 < n <= 10000 else None


def fetch_link_preview(url: str) -> dict | None:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if host in YOUTUBE_HOSTS:
        return youtube_preview(url)
    if not public_url(url):
        return None
    # a direct GIF file from Tenor/Giphy (media.tenor.com/....gif) is shown as is
    if gif_site(host) and urllib.parse.urlsplit(url).path.lower().endswith(".gif"):
        site = "Tenor" if host.endswith("tenor.com") else "GIPHY"
        return {"url": url, "title": "", "description": "", "image": link_image_path(url), "site": site, "gif": True}
    req = urllib.request.Request(
        url,
        headers={
            # many sites (YouTube, social networks) only serve Open Graph tags to preview bots
            "User-Agent": "Mozilla/5.0 (compatible; OreolBot/1.0; link preview)",
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
            "Accept-Language": "ru,en;q=0.8",
        },
    )
    try:
        with _link_opener.open(req, timeout=LINK_TIMEOUT) as r:
            final = r.geturl()
            ctype = r.headers.get("Content-Type", "")
            if "html" not in ctype.lower():
                return None
            try:
                decoder = codecs.getincrementaldecoder(r.headers.get_content_charset() or "utf-8")(errors="replace")
            except LookupError:
                decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            p = _MetaParser()
            got = 0
            # stop as soon as <head> is over instead of downloading the whole page
            while got < LINK_MAX_BYTES and not p.done:
                chunk = r.read(64 * 1024)
                if not chunk:
                    break
                got += len(chunk)
                try:
                    p.feed(decoder.decode(chunk))
                except Exception:
                    break
    except Exception:
        return None
    m = p.meta
    title = _clip(m.get("og:title") or m.get("twitter:title") or p.title, 160)
    if not title:
        return None
    desc = _clip(m.get("og:description") or m.get("twitter:description") or m.get("description"), 300)
    image = m.get("og:image") or m.get("og:image:url") or m.get("twitter:image") or ""
    image = urllib.parse.urljoin(final, image.strip()) if image else ""
    if not image.startswith(("https://", "http://")) or len(image) > 2048:
        image = ""
    host = urllib.parse.urlsplit(final).hostname or ""
    site = _clip(m.get("og:site_name") or (host[4:] if host.startswith("www.") else host), 60)
    data = {"url": url, "title": title, "description": desc, "image": link_image_path(image) if image else None, "site": site}
    # GIF services: show the whole animation at its own aspect ratio instead of a cropped thumbnail
    if image and gif_site(host.lower()) and (m.get("og:image:type") == "image/gif" or image.lower().endswith(".gif")):
        data.update(gif=True, w=_int(m.get("og:image:width")), h=_int(m.get("og:image:height")))
    return data


# The browser loads preview images through us, so the third-party site never sees its IP or viewing time.
# The URL is signed: the proxy serves only images it found itself, it is not an open proxy.
_LINK_IMG_KEY = secrets.token_bytes(32)
LINK_IMG_MAX = 10 * 1024 * 1024  # full-size Tenor/Giphy GIFs
LINK_IMG_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"}


def _link_img_sig(url: str) -> str:
    return hmac.new(_LINK_IMG_KEY, url.encode(), hashlib.sha256).hexdigest()[:32]


def link_image_path(url: str) -> str:
    return f"/api/link-image?u={urllib.parse.quote(url, safe='')}&s={_link_img_sig(url)}"


def fetch_link_image(url: str) -> tuple[bytes, str] | None:
    got = _fetch_image(url)
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if not got and host.endswith("ytimg.com"):
        # some networks cannot reach YouTube's image hosts; wsrv.nl relays the same thumbnail
        got = _fetch_image("https://wsrv.nl/?url=" + urllib.parse.quote(url.split("://", 1)[-1], safe=""))
    return got


def _fetch_image(url: str) -> tuple[bytes, str] | None:
    if not public_url(url):
        return None
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; OreolBot/1.0; link preview)", "Accept": "image/*"})
    try:
        with _link_opener.open(req, timeout=LINK_TIMEOUT) as r:
            ctype = (r.headers.get_content_type() or "").lower()
            if ctype not in LINK_IMG_TYPES:
                return None
            data = r.read(LINK_IMG_MAX + 1)
    except Exception:
        return None
    if len(data) > LINK_IMG_MAX:
        return None
    return data, ctype


def link_preview_cached(url: str) -> dict | None:
    now = time.time()
    hit = _link_cache.get(url)
    # a failed fetch is retried sooner than a good preview expires
    if hit and now - hit[0] < (LINK_CACHE_SEC if hit[1] else LINK_FAIL_CACHE_SEC):
        return hit[1]
    data = fetch_link_preview(url)
    if len(_link_cache) >= LINK_CACHE_MAX:
        for k in sorted(_link_cache, key=lambda k: _link_cache[k][0])[: LINK_CACHE_MAX // 5]:
            _link_cache.pop(k, None)
    _link_cache[url] = (now, data)
    return data


@app.get("/api/link-preview")
async def link_preview(url: str, request: Request):
    if not current_user(request):
        return unauthorized()
    url = url.strip()[:2048]
    data = await asyncio.to_thread(link_preview_cached, url)
    if not data:
        return JSONResponse({"error": "Нет предпросмотра"}, status_code=404)
    return data


@app.get("/api/link-image")
async def link_image(u: str, s: str):
    if not hmac.compare_digest(s.encode(), _link_img_sig(u).encode()):
        return JSONResponse({"error": "Нет картинки"}, status_code=404)
    got = await asyncio.to_thread(fetch_link_image, u)
    if not got:
        return JSONResponse({"error": "Нет картинки"}, status_code=404)
    data, ctype = got
    return Response(
        data,
        media_type=ctype,
        headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'"},
    )


@app.get("/api/chat/{room}/history")
async def chat_history(room: str, request: Request, before: int, limit: int = 100):
    row = current_user(request)
    if not row:
        return unauthorized()
    conn = db()
    ok = member_channel(conn, row["id"], room)
    conn.close()
    if not ok:
        return JSONResponse({"error": "Нет доступа к этому чату"}, status_code=403)
    limit = max(1, min(limit, 200))
    msgs = get_history_v2(room, limit=limit, user_id=row["id"], before=before)
    return {"messages": msgs, "more": len(msgs) == limit}


CHAT_MEDIA_KINDS = {
    "photo": "a.mime LIKE 'image/%' AND a.mime != 'image/gif'",
    "gif": "a.mime = 'image/gif'",
    "video": "a.mime LIKE 'video/%'",
    "file": "a.key LIKE 'files/%'",
}
LINK_RE = re.compile(r"(?<![\w./@])(?:https?://|www\.)[^\s<>\"]+[^\s<>\".,;:!?)\]}'»]", re.I)


def chat_access(request: Request, room: str):
    row = current_user(request)
    if not row:
        return None, unauthorized()
    conn = db()
    ok = member_channel(conn, row["id"], room)
    conn.close()
    if not ok:
        return None, JSONResponse({"error": "Нет доступа к этому чату"}, status_code=403)
    return row, None


@app.get("/api/chat/{room}/media")
async def chat_media(room: str, kind: str, request: Request, before: int | None = None, limit: int = 60):
    """Chat showcase: photos, GIFs, videos, files or links, newest first. `next` is the cursor for older items."""
    row, err = chat_access(request, room)
    if err:
        return err
    limit = max(1, min(limit, 100))
    conn = chat_conn()
    hidden = "m.id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)"
    if kind in CHAT_MEDIA_KINDS:
        rows = conn.execute(
            "SELECT a.id, a.key, a.mime, a.width, a.height, a.name, a.size, m.id AS msg, m.username, m.timestamp "
            f"FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.room = ? AND {hidden} "
            f"AND {CHAT_MEDIA_KINDS[kind]} AND a.id < ? ORDER BY a.id DESC LIMIT ?",
            (room, row["id"], before or 2**62, limit),
        ).fetchall()
        conn.close()
        items = [{**att_json(r), "msg": r["msg"], "user": r["username"], "ts": to_iso(r["timestamp"])} for r in rows]
        return {"items": items, "next": rows[-1]["id"] if len(rows) == limit else None}
    if kind != "link":
        conn.close()
        return JSONResponse({"error": "Неизвестный раздел"}, status_code=400)
    items, cursor, done = [], before or 2**62, False
    # links are pulled out of message text, so messages are scanned in pages until enough links are found
    while len(items) < limit and not done:
        rows = conn.execute(
            f"SELECT m.id, m.username, m.content, m.timestamp FROM messages m WHERE m.room = ? AND {hidden} "
            "AND m.id < ? AND (m.content LIKE '%http%' OR m.content LIKE '%www.%') ORDER BY m.id DESC LIMIT 200",
            (room, row["id"], cursor),
        ).fetchall()
        done = len(rows) < 200
        for r in rows:
            cursor = r["id"]
            for u in dict.fromkeys(m.group(0) for m in LINK_RE.finditer(r["content"] or "")):
                items.append({"url": u if u.lower().startswith("http") else "https://" + u, "msg": r["id"], "user": r["username"], "ts": to_iso(r["timestamp"])})
            if len(items) >= limit:
                done = done and r["id"] == rows[-1]["id"]
                break
    conn.close()
    return {"items": items, "next": None if done else cursor}


@app.get("/api/chat/{room}/search")
async def chat_search(room: str, q: str, request: Request, before: int | None = None, limit: int = 30):
    """Messages containing q (case-insensitive, Cyrillic included), newest first."""
    row, err = chat_access(request, room)
    if err:
        return err
    q = q.strip().lower()[:100]
    if not q:
        return {"messages": [], "next": None}
    limit = max(1, min(limit, 50))
    conn = chat_conn()
    # SQLite's LIKE only folds ASCII case, so compare Python-lowercased text
    conn.create_function("ulower", 1, lambda t: t.lower() if isinstance(t, str) else t, deterministic=True)
    pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    rows = conn.execute(
        f"SELECT {MSG_COLS} FROM messages WHERE room = ? AND sys IS NULL "
        "AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?) "
        "AND id < ? AND ulower(content) LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?",
        (room, row["id"], before or 2**62, pattern, limit),
    ).fetchall()
    out = [msg_json(conn, r) for r in rows]
    conn.close()
    return {"messages": out, "next": rows[-1]["id"] if len(rows) == limit else None}


@app.get("/api/chat/{room}/reads/{msg_id}")
async def message_reads(room: str, msg_id: int, request: Request):
    """Who read a message and when: the first time a member's mark reached it or moved past it.
    Reads from before the log existed have no time (at = null).
    """
    row = current_user(request)
    if not row:
        return unauthorized()
    conn = db()
    ok = member_channel(conn, row["id"], room)
    conn.close()
    if not ok:
        return JSONResponse({"error": "Нет доступа к этому чату"}, status_code=403)
    conn = chat_conn()
    author = conn.execute("SELECT username FROM messages WHERE id = ? AND room = ?", (msg_id, room)).fetchone()
    rows = conn.execute(
        "SELECT u.username, (SELECT MIN(l.at) FROM chat_read_log l WHERE l.user_id = r.user_id AND l.room = r.room AND l.last_id >= ?) AS at "
        "FROM chat_reads r JOIN users u ON u.id = r.user_id WHERE r.room = ? AND r.last_id >= ?",
        (msg_id, room, msg_id),
    ).fetchall()
    conn.close()
    who = author["username"] if author else None
    out = [{"user": r["username"], "at": r["at"]} for r in rows if r["username"] != who]
    out.sort(key=lambda x: x["at"] or "", reverse=True)
    return {"reads": out}


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


# Security headers. Page CSP: own scripts only (the inline theme script in index.html is allowed by hash),
# external resources only for Google Fonts, no framing by other sites.
_csp_cache: tuple[float, str] | None = None


def _origins(url: str) -> str:
    """wss://host/rtc -> "wss://host https://host": LiveKit uses both WebSocket and HTTP."""
    u = urllib.parse.urlsplit(url)
    if not u.netloc:
        return ""
    http = {"wss": "https", "ws": "http"}.get(u.scheme, u.scheme)
    return f"{u.scheme}://{u.netloc} {http}://{u.netloc}"


def page_csp() -> str:
    global _csp_cache
    index = WEB_DIST / "index.html"
    try:
        mtime = index.stat().st_mtime
    except OSError:
        mtime = 0.0
    if _csp_cache and _csp_cache[0] == mtime:
        return _csp_cache[1]
    hashes = []
    if mtime:
        page = index.read_text(encoding="utf-8")
        for body in re.findall(r"<script(?![^>]*\ssrc=)[^>]*>(.*?)</script>", page, re.S):
            digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
            hashes.append(f"'sha256-{digest}'")
    csp = "; ".join(
        [
            "default-src 'self'",
            "script-src 'self' blob: " + " ".join(hashes),  # blob: for the noise gate AudioWorklet
            "worker-src 'self' blob:",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' data: https://fonts.gstatic.com",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            f"connect-src 'self' {_origins(LK_SERVER_URL)}".rstrip(),
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]
    )
    _csp_cache = (mtime, csp)
    return csp


@app.middleware("http")
async def security_headers(request: Request, call_next):
    if (
        request.method not in ("GET", "HEAD", "OPTIONS")
        and request.cookies.get(SESSION_COOKIE)
        and not same_origin(request.headers)
    ):
        return JSONResponse({"error": "Запрос с чужого сайта"}, status_code=403)
    resp = await call_next(request)
    h = resp.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=()")
    if request.headers.get("x-forwarded-proto") == "https" or request.url.scheme == "https":
        h.setdefault("Strict-Transport-Security", "max-age=31536000")
    if h.get("content-type", "").startswith("text/html"):
        h.setdefault("Content-Security-Policy", page_csp())
    return resp


class SpaStatic(StaticFiles):
    """SPA routing: page URLs (/servers/..., /settings/...) get index.html and the UI parses them.
    Missing files (with an extension) and /api still return 404.
    """

    async def get_response(self, path, scope):
        page = not path.startswith("api") and "." not in path.rsplit("/", 1)[-1]
        try:
            resp = await super().get_response(path, scope)
        except HTTPException as e:
            if e.status_code == 404 and page:
                return await super().get_response("index.html", scope)
            raise
        # A custom 404.html is returned as a response, not raised
        if resp.status_code == 404 and page:
            return await super().get_response("index.html", scope)
        return resp


if WEB_DIST.is_dir():
    app.mount("/", SpaStatic(directory=WEB_DIST, html=True), name="web")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
