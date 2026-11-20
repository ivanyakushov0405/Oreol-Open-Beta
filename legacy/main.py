import uvicorn
import sqlite3
import os
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from livekit import api

app = FastAPI()

# --- КОНФИГУРАЦИЯ ---
LK_SERVER_URL = os.getenv("LK_SERVER_URL", "ws://127.0.0.1:7880")
LK_API_URL = os.getenv("LK_API_URL", LK_SERVER_URL.replace("wss://", "https://").replace("ws://", "http://"))
LK_API_KEY = os.getenv("LK_API_KEY")
LK_API_SECRET = os.getenv("LK_API_SECRET")
DB_NAME = os.getenv("DB_NAME", "chat.db")
VOICE_ROOM_NAME = os.getenv("VOICE_ROOM_NAME", "Voice-Lounge")


def is_audio_track(track) -> bool:
    track_type = getattr(track, "type", "")
    track_type_name = getattr(track_type, "name", "")
    track_source = str(getattr(track, "source", "")).lower()
    return (
        "audio" in str(track_type).lower()
        or "audio" in str(track_type_name).lower()
        or "microphone" in track_source
    )


def is_participant_muted(participant) -> bool:
    audio_tracks = [track for track in getattr(participant, "tracks", []) if is_audio_track(track)]
    if not audio_tracks:
        return False
    return all(getattr(track, "muted", False) for track in audio_tracks)


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


# --- СТАТИКА ---
@app.get("/logo.png")
async def get_logo():
    return FileResponse("logo.png", media_type="image/png")


# --- ГЛАВНАЯ СТРАНИЦА ---
@app.get("/", response_class=HTMLResponse)
async def get_index():
    with open("index.html", "r", encoding="utf-8") as f:
        return f.read()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
