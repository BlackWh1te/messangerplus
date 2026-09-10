import os

with open("backend/main.py", "r", encoding="utf-8") as f:
    code = f.read()

# 1. Add imports
if "UploadFile" not in code:
    code = code.replace(
        "from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect",
        "from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File\nfrom fastapi.staticfiles import StaticFiles\nimport uuid"
    )

# 2. Add static files mount
if "app.mount" not in code:
    os.makedirs("backend/uploads", exist_ok=True)
    code = code.replace(
        "app.add_middleware(",
        "app.mount(\"/uploads\", StaticFiles(directory=\"uploads\"), name=\"uploads\")\n\napp.add_middleware("
    )

# 3. Add /upload endpoint
if "@app.post(\"/upload\")" not in code:
    upload_code = """
@app.post("/upload")
async def upload_image(file: UploadFile = File(...), current_user: str = Depends(get_current_user)):
    try:
        ext = file.filename.split(".")[-1]
        filename = f"{uuid.uuid4().hex}.{ext}"
        filepath = os.path.join("uploads", filename)
        
        with open(filepath, "wb") as f:
            f.write(await file.read())
            
        return {"url": f"{API_URL}/uploads/{filename}"}
    except Exception as e:
        log.error("Upload error: %s", e)
        raise HTTPException(status_code=500, detail="Upload failed")
"""
    upload_code = upload_code.replace("f\"{API_URL}/uploads/{filename}\"", "f\"/uploads/{filename}\"")
    code += upload_code

with open("backend/main.py", "w", encoding="utf-8") as f:
    f.write(code)

print("Backend patched successfully.")
