"""
MessengerPlus Backend — Production-hardened FastAPI server
- HTTP POST /send as primary message delivery (always works, even on Android)
- WebSocket /ws/{token} for real-time push (best-effort)
- Delivery + read receipts
- Full error handling — server never crashes
"""

import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Optional

import aiosqlite
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from pydantic import BaseModel, Field

# ─── Config ──────────────────────────────────────────────────────────────────

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("messenger")

SECRET_KEY: str = os.getenv("SECRET_KEY", "fallback-secret-change-me")
ALGORITHM = "HS256"
TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

DB_PATH = os.path.join(os.path.dirname(__file__), "messages.db")

USERS: dict[str, str] = {
    os.getenv("USER1_NAME", "user1"): os.getenv("USER1_PASS", "pass1"),
    os.getenv("USER2_NAME", "user2"): os.getenv("USER2_PASS", "pass2"),
}

# ─── Database ─────────────────────────────────────────────────────────────────

async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                sender    TEXT    NOT NULL,
                content   TEXT    NOT NULL,
                timestamp TEXT    NOT NULL,
                delivered INTEGER NOT NULL DEFAULT 0,
                read      INTEGER NOT NULL DEFAULT 0
            )
        """)
        # Safe migrations — ignore if column already exists
        for col_def in ["delivered INTEGER NOT NULL DEFAULT 0", "read INTEGER NOT NULL DEFAULT 0"]:
            col = col_def.split()[0]
            try:
                await db.execute(f"ALTER TABLE messages ADD COLUMN {col_def}")
            except Exception:
                pass
        await db.commit()
    log.info("Database ready: %s", DB_PATH)


async def db_save_message(sender: str, content: str) -> dict:
    ts = datetime.utcnow().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO messages (sender, content, timestamp, delivered, read) VALUES (?,?,?,0,0)",
            (sender, content, ts),
        )
        await db.commit()
    return {"id": cur.lastrowid, "sender": sender, "content": content,
            "timestamp": ts, "delivered": False, "read": False}


async def db_get_messages(limit: int = 100) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id,sender,content,timestamp,delivered,read FROM messages ORDER BY id DESC LIMIT ?",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in reversed(rows)]


async def db_mark_delivered(sender: str) -> list[int]:
    """Mark all undelivered messages from sender as delivered. Returns their IDs."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id FROM messages WHERE sender=? AND delivered=0", (sender,)
        ) as cur:
            ids = [r[0] for r in await cur.fetchall()]
        if ids:
            await db.execute(
                "UPDATE messages SET delivered=1 WHERE sender=? AND delivered=0", (sender,)
            )
            await db.commit()
    return ids


async def db_mark_message_delivered(msg_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE messages SET delivered=1 WHERE id=?", (msg_id,))
        await db.commit()


async def db_mark_read_by(reader: str) -> None:
    """Mark all messages NOT from reader as read."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE messages SET read=1 WHERE sender != ? AND read=0", (reader,)
        )
        await db.commit()

# ─── Auth ─────────────────────────────────────────────────────────────────────

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/login")


def create_token(username: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE_MINUTES)
    return jwt.encode({"sub": username, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload.get("sub")
    except JWTError:
        return None


async def require_user(token: str = Depends(oauth2_scheme)) -> str:
    username = decode_token(token)
    if not username or username not in USERS:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return username

# ─── WebSocket Connection Manager ────────────────────────────────────────────

class ConnectionManager:
    """Thread-safe (asyncio) manager for active WebSocket connections."""

    def __init__(self) -> None:
        # username → list of open WebSocket connections (multiple tabs/devices)
        self._conns: dict[str, list[WebSocket]] = {}
        self._statuses: dict[str, dict] = {
            u: {"online": False, "last_seen": None} for u in USERS
        }

    # ── Connection lifecycle ──────────────────────────────────────────────

    async def accept(self, username: str, ws: WebSocket) -> None:
        await ws.accept()
        self._conns.setdefault(username, []).append(ws)
        self._statuses.setdefault(username, {"online": False, "last_seen": None})
        self._statuses[username]["online"] = True
        log.info("WS connected: %s (total sockets: %d)", username, len(self._conns[username]))

    def remove(self, username: str, ws: WebSocket) -> None:
        sockets = self._conns.get(username, [])
        if ws in sockets:
            sockets.remove(ws)
        if not sockets:
            self._conns.pop(username, None)
            self._statuses.setdefault(username, {"online": False, "last_seen": None})
            self._statuses[username]["online"] = False
            self._statuses[username]["last_seen"] = datetime.utcnow().isoformat()
            log.info("WS disconnected: %s", username)

    def is_online(self, username: str) -> bool:
        return bool(self._conns.get(username))

    @property
    def statuses(self) -> dict:
        return dict(self._statuses)

    # ── Sending ───────────────────────────────────────────────────────────

    async def _send_to_sockets(self, username: str, payload: dict) -> None:
        """Send to all sockets for a user, pruning dead ones silently."""
        sockets = list(self._conns.get(username, []))
        dead: list[WebSocket] = []
        text = json.dumps(payload)
        for ws in sockets:
            try:
                await ws.send_text(text)
            except Exception as exc:
                log.debug("Dead socket for %s: %s", username, exc)
                dead.append(ws)
        for ws in dead:
            self.remove(username, ws)

    async def send_to(self, username: str, payload: dict) -> None:
        try:
            await self._send_to_sockets(username, payload)
        except Exception as exc:
            log.error("send_to(%s) error: %s", username, exc)

    async def broadcast(self, payload: dict) -> None:
        for username in list(self._conns):
            await self.send_to(username, payload)


manager = ConnectionManager()

# ─── App & Middleware ─────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield

app = FastAPI(title="MessengerPlus", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Schemas ──────────────────────────────────────────────────────────────────

class SendBody(BaseModel):
    content: str = Field(..., min_length=1, max_length=4000)

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict:
    return {"status": "ok", "users_online": [u for u, s in manager.statuses.items() if s["online"]]}


@app.post("/login")
async def login(form: OAuth2PasswordRequestForm = Depends()) -> dict:
    expected = USERS.get(form.username)
    if not expected or expected != form.password:
        log.warning("Failed login attempt for user: %s", form.username)
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_token(form.username)
    log.info("Login: %s", form.username)
    return {"access_token": token, "token_type": "bearer", "username": form.username}


@app.get("/messages")
async def get_messages(username: str = Depends(require_user)) -> list:
    try:
        return await db_get_messages()
    except Exception as exc:
        log.error("get_messages error: %s", exc)
        raise HTTPException(status_code=500, detail="Could not load messages")


@app.get("/status")
async def get_status(username: str = Depends(require_user)) -> dict:
    return manager.statuses


@app.post("/send")
async def send_http(body: SendBody, username: str = Depends(require_user)) -> dict:
    """
    Primary message delivery endpoint — always works even when WebSocket is unavailable.
    Used by Android and as fallback for all clients.
    """
    try:
        msg = await db_save_message(username, body.content)
    except Exception as exc:
        log.error("db_save_message error: %s", exc)
        raise HTTPException(status_code=500, detail="Could not save message")

    # Push to all connected clients via WebSocket (best-effort)
    try:
        await manager.broadcast({"type": "message", "data": msg})
    except Exception as exc:
        log.error("broadcast error after HTTP send: %s", exc)

    # Mark delivered if any other user is currently connected
    other_users = [u for u in USERS if u != username]
    for other in other_users:
        if manager.is_online(other):
            try:
                await db_mark_message_delivered(msg["id"])
                msg["delivered"] = True
                await manager.send_to(username, {"type": "delivered", "id": msg["id"]})
            except Exception as exc:
                log.error("mark_delivered error: %s", exc)

    log.info("HTTP send: %s → %d chars", username, len(body.content))
    return msg


# ─── WebSocket ────────────────────────────────────────────────────────────────

@app.websocket("/ws/{token}")
async def websocket_endpoint(ws: WebSocket, token: str) -> None:
    username = decode_token(token)
    if not username or username not in USERS:
        log.warning("WS rejected: invalid token")
        await ws.close(code=4001)
        return

    await manager.accept(username, ws)
    other_users = [u for u in USERS if u != username]

    # Notify everyone of updated online status
    try:
        await manager.broadcast({"type": "status", "data": manager.statuses})
    except Exception as exc:
        log.error("status broadcast on connect: %s", exc)

    # Mark messages from others as delivered now that this user is online
    for other in other_users:
        try:
            ids = await db_mark_delivered(other)
            for mid in ids:
                await manager.send_to(other, {"type": "delivered", "id": mid})
        except Exception as exc:
            log.error("mark_delivered on connect error: %s", exc)

    try:
        while True:
            try:
                raw = await ws.receive_text()
            except WebSocketDisconnect:
                break
            except Exception as exc:
                log.error("WS receive error for %s: %s", username, exc)
                break

            # Parse frame
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                log.debug("Malformed WS frame from %s", username)
                continue

            msg_type = payload.get("type", "message")

            # ── Ping keepalive ──────────────────────────────────────────
            if msg_type == "ping":
                try:
                    await ws.send_text(json.dumps({"type": "pong"}))
                except Exception:
                    break
                continue

            # ── Read receipt ────────────────────────────────────────────
            if msg_type == "read":
                try:
                    await db_mark_read_by(username)
                    for other in other_users:
                        await manager.send_to(other, {"type": "read", "reader": username})
                except Exception as exc:
                    log.error("read receipt error: %s", exc)
                continue

            # ── Chat message ────────────────────────────────────────────
            content = payload.get("content", "").strip()
            if not content or len(content) > 4000:
                continue

            try:
                msg = await db_save_message(username, content)
                await manager.broadcast({"type": "message", "data": msg})

                # Instant delivery receipt if other user is online
                for other in other_users:
                    if manager.is_online(other):
                        await db_mark_message_delivered(msg["id"])
                        await manager.send_to(username, {"type": "delivered", "id": msg["id"]})
            except Exception as exc:
                log.error("WS message handling error: %s", exc)

    finally:
        manager.remove(username, ws)
        try:
            if not manager.is_online(username):
                await manager.broadcast({"type": "status", "data": manager.statuses})
        except Exception as exc:
            log.error("status broadcast on disconnect: %s", exc)
        log.info("WS cleanup done: %s", username)
