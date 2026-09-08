import asyncio
import json
import os
import aiosqlite
from datetime import datetime, timedelta
from typing import Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from dotenv import load_dotenv

load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY", "fallback-secret")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days
DB_PATH = os.path.join(os.path.dirname(__file__), "messages.db")

USERS = {
    os.getenv("USER1_NAME", "user1"): os.getenv("USER1_PASS", "pass1"),
    os.getenv("USER2_NAME", "user2"): os.getenv("USER2_PASS", "pass2"),
}

app = FastAPI(title="MessengerPlus")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/login")

# ─── DB ───────────────────────────────────────────────────────────────────────

async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL
            )
        """)
        await db.commit()

async def save_message(sender: str, content: str) -> dict:
    ts = datetime.utcnow().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO messages (sender, content, timestamp) VALUES (?, ?, ?)",
            (sender, content, ts)
        )
        await db.commit()
        return {"id": cur.lastrowid, "sender": sender, "content": content, "timestamp": ts}

async def get_messages(limit: int = 100) -> list:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, sender, content, timestamp FROM messages ORDER BY id DESC LIMIT ?",
            (limit,)
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in reversed(rows)]

# ─── Auth ─────────────────────────────────────────────────────────────────────

def create_token(username: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode({"sub": username, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)

def verify_token(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload.get("sub")
    except JWTError:
        return None

async def get_current_user(token: str = Depends(oauth2_scheme)) -> str:
    username = verify_token(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token")
    return username

# ─── WebSocket Manager ────────────────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        self.connections: dict[str, list[WebSocket]] = {}
        self.user_statuses = {
            os.getenv("USER1_NAME", "user1"): {"online": False, "last_seen": None},
            os.getenv("USER2_NAME", "user2"): {"online": False, "last_seen": None},
        }

    async def connect(self, username: str, ws: WebSocket):
        await ws.accept()
        if username not in self.connections:
            self.connections[username] = []
        self.connections[username].append(ws)

    def disconnect(self, username: str, ws: WebSocket):
        if username in self.connections:
            if ws in self.connections[username]:
                self.connections[username].remove(ws)
            if not self.connections[username]:
                self.connections.pop(username, None)

    def update_status(self, username: str, online: bool):
        if username in self.user_statuses:
            self.user_statuses[username]["online"] = online
            if not online:
                self.user_statuses[username]["last_seen"] = datetime.utcnow().isoformat()

    def is_online(self, username: str) -> bool:
        return username in self.connections and len(self.connections[username]) > 0

    async def broadcast(self, message: dict):
        for uname, ws_list in list(self.connections.items()):
            dead_ws = []
            for ws in ws_list:
                try:
                    await ws.send_text(json.dumps(message))
                except Exception:
                    dead_ws.append(ws)
            for ws in dead_ws:
                self.disconnect(uname, ws)

manager = ConnectionManager()

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    await init_db()

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/login")
async def login(form: OAuth2PasswordRequestForm = Depends()):
    pwd = USERS.get(form.username)
    if not pwd or pwd != form.password:
        raise HTTPException(status_code=401, detail="Bad credentials")
    token = create_token(form.username)
    return {"access_token": token, "token_type": "bearer", "username": form.username}

@app.get("/messages")
async def messages(username: str = Depends(get_current_user)):
    return await get_messages()

@app.get("/status")
async def get_status(username: str = Depends(get_current_user)):
    return manager.user_statuses

@app.websocket("/ws/{token}")
async def websocket_endpoint(websocket: WebSocket, token: str):
    username = verify_token(token)
    if not username:
        await websocket.close(code=4001)
        return
    
    await manager.connect(username, websocket)
    manager.update_status(username, True)
    await manager.broadcast({"type": "status", "data": manager.user_statuses})
    
    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)
            content = payload.get("content", "").strip()
            if content:
                msg = await save_message(username, content)
                await manager.broadcast({"type": "message", "data": msg})
    except WebSocketDisconnect:
        manager.disconnect(username, websocket)
        if not manager.is_online(username):
            manager.update_status(username, False)
            await manager.broadcast({"type": "status", "data": manager.user_statuses})
