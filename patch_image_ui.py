
import os

with open("app/chat/page.tsx", "r", encoding="utf-8") as f:
    code = f.read()

import re

# 1. Replace <img> with <img loading="lazy" /> (It actually already has loading="lazy")
# Wait, let us just add an explicit onClick to the send button to ensure it works on Android.
old_btn = """<button
            type="submit"
            disabled={!input.trim()}"""
new_btn = """<button
            type="button"
            onClick={(e) => { e.preventDefault(); if(input.trim()) sendMessage(e as any); }}
            disabled={!input.trim() || isUploading}"""
code = code.replace(old_btn, new_btn)

with open("app/chat/page.tsx", "w", encoding="utf-8") as f:
    f.write(code)

print("Image UI patched.")

