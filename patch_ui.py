
import os

with open("app/chat/page.tsx", "r", encoding="utf-8") as f:
    code = f.read()

# 1. Add an isUploading state
if "const [isUploading, setIsUploading]" not in code:
    code = code.replace(
        "const [connected, setConnected] = useState(false)",
        "const [connected, setConnected] = useState(false)\n  const [isUploading, setIsUploading] = useState(false)"
    )

# 2. Update handleUpload
new_handle_upload = """
  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files || e.target.files.length === 0) return
    const file = e.target.files[0]
    e.target.value = ' // reset
    setIsUploading(true)
    try {
      const res = await uploadImage(tokenRef.current!, file)
      sendMessage(undefined, `[image:${res.url}]`)
    } catch (err) {
      alert("Upload failed: " + err)
    } finally {
      setIsUploading(false)
    }
  }
"""
import re
code = re.sub(r"async function handleUpload.*?\} catch \(err\) \{.*?alert.*?\}[\s\n]+\}", new_handle_upload.strip(), code, flags=re.DOTALL)

# 3. Add spinner to the upload button
if "animate-spin" not in code:
    # Replace the paperclip SVG with a conditional spinner
    old_btn = """<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-6 h-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>"""
    new_btn = """{isUploading ? <svg className="animate-spin w-5 h-5 text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-6 h-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>}"""
    code = code.replace(old_btn, new_btn)

# 4. Disable buttons while uploading
code = code.replace(
    """<button type="button" onClick={() => fileInputRef.current?.click()}""",
    """<button type="button" disabled={isUploading} onClick={() => fileInputRef.current?.click()}"""
)

with open("app/chat/page.tsx", "w", encoding="utf-8") as f:
    f.write(code)

print("UI patched successfully.")

