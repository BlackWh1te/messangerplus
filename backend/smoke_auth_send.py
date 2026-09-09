import json
import asyncio
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import websockets


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def request(method: str, url: str, data: bytes | None = None, headers: dict[str, str] | None = None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=5) as response:
        body = response.read()
        if not body:
            return None
        return json.loads(body.decode("utf-8"))


def wait_for_health(base_url: str, proc: subprocess.Popen) -> None:
    deadline = time.time() + 10
    last_error = ""
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        try:
            request("GET", f"{base_url}/health")
            return
        except Exception as exc:
            last_error = str(exc)
            time.sleep(0.25)

    stdout, stderr = proc.communicate(timeout=2)
    raise RuntimeError(
        "Backend did not start. "
        f"Last health error: {last_error}\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}"
    )


def multipart_body(field_name: str, filename: str, content_type: str, content: bytes) -> tuple[str, bytes]:
    boundary = "----messengerplus-smoke-boundary"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8") + content + f"\r\n--{boundary}--\r\n".encode("utf-8")
    return boundary, body


async def assert_call_signal(base_url: str, caller_token: str, receiver_token: str) -> None:
    ws_base = base_url.replace("http", "ws", 1)
    call_id = "smoke-call"

    async with websockets.connect(f"{ws_base}/ws/{caller_token}") as caller:
        async with websockets.connect(f"{ws_base}/ws/{receiver_token}") as receiver:
            await caller.send(
                json.dumps(
                    {
                        "type": "call:offer",
                        "callId": call_id,
                        "data": {
                            "mode": "audio",
                            "sdp": {"type": "offer", "sdp": "v=0"},
                        },
                    }
                )
            )

            deadline = time.time() + 5
            while time.time() < deadline:
                payload = json.loads(await asyncio.wait_for(receiver.recv(), timeout=5))
                if payload.get("type") == "call:offer":
                    if payload.get("from") != "user1":
                        raise AssertionError(f"Unexpected signal sender: {payload}")
                    if payload.get("callId") != call_id:
                        raise AssertionError(f"Unexpected signal call id: {payload}")
                    return

    raise AssertionError("Receiver did not receive call offer")


def main() -> int:
    root = Path(__file__).resolve().parent
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"

    with tempfile.TemporaryDirectory(prefix="messengerplus-smoke-", ignore_cleanup_errors=True) as tmp:
        env = os.environ.copy()
        env.update(
            {
                "SECRET_KEY": "smoke-secret",
                "USER1_NAME": "user1",
                "USER1_PASS": "pass1",
                "USER2_NAME": "user2",
                "USER2_PASS": "pass2",
                "MESSENGER_DB_PATH": str(Path(tmp) / "messages.db"),
                "MESSENGER_UPLOAD_DIR": str(Path(tmp) / "uploads"),
            }
        )

        proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--log-level",
                "warning",
            ],
            cwd=root,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        try:
            wait_for_health(base_url, proc)

            user1_body = urllib.parse.urlencode({"username": "user1", "password": "pass1"}).encode("utf-8")
            user1_login = request(
                "POST",
                f"{base_url}/login",
                user1_body,
                {"Content-Type": "application/x-www-form-urlencoded"},
            )
            token = user1_login["access_token"]
            auth_headers = {"Authorization": f"Bearer {token}"}

            sent = request(
                "POST",
                f"{base_url}/send",
                json.dumps({"content": "android smoke message", "nonce": "smoke-nonce-1"}).encode("utf-8"),
                {"Content-Type": "application/json", **auth_headers},
            )
            if sent["content"] != "android smoke message":
                raise AssertionError(f"Unexpected sent payload: {sent}")
            sent_again = request(
                "POST",
                f"{base_url}/send",
                json.dumps({"content": "android smoke message", "nonce": "smoke-nonce-1"}).encode("utf-8"),
                {"Content-Type": "application/json", **auth_headers},
            )
            if sent_again["id"] != sent["id"]:
                raise AssertionError(f"Nonce retry created a duplicate message: {sent_again}")

            messages = request("GET", f"{base_url}/messages", headers=auth_headers)
            if not any(msg["content"] == "android smoke message" for msg in messages):
                raise AssertionError(f"Sent message missing from history: {messages}")

            boundary, upload_body = multipart_body("file", "smoke.png", "image/png", b"fake-image")
            uploaded = request(
                "POST",
                f"{base_url}/upload",
                upload_body,
                {"Content-Type": f"multipart/form-data; boundary={boundary}", **auth_headers},
            )
            if not str(uploaded.get("url", "")).startswith("/uploads/"):
                raise AssertionError(f"Unexpected upload payload: {uploaded}")

            user2_body = urllib.parse.urlencode({"username": "user2", "password": "pass2"}).encode("utf-8")
            user2_login = request(
                "POST",
                f"{base_url}/login",
                user2_body,
                {"Content-Type": "application/x-www-form-urlencoded"},
            )
            asyncio.run(assert_call_signal(base_url, token, user2_login["access_token"]))

            print("smoke ok: login, send, nonce retry, messages, upload, call signaling")
            return 0
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
