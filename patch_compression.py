
import os

with open("app/chat/page.tsx", "r", encoding="utf-8") as f:
    code = f.read()

compression_code = """
async function compressImage(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = event => {
      const img = new window.Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const MAX_WIDTH = 1200;
        const MAX_HEIGHT = 1200;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height = Math.round((height *= MAX_WIDTH / width));
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width = Math.round((width *= MAX_HEIGHT / height));
            height = MAX_HEIGHT;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(img, 0, 0, width, height);

        canvas.toBlob(blob => {
          if (blob) {
            resolve(new File([blob], file.name, { type: "image/jpeg" }));
          } else {
            resolve(file); // fallback
          }
        }, "image/jpeg", 0.7); // 70% quality
      };
      img.onerror = () => resolve(file); // fallback on error
    };
    reader.onerror = () => resolve(file);
  });
}
"""

if "compressImage" not in code:
    code = code.replace("export default function ChatPage() {", compression_code + "\nexport default function ChatPage() {")

    # Update handleUpload to use it
    old_upload = "const res = await uploadImage(tokenRef.current!, file)"
    new_upload = """const compressed = file.type.startsWith("image/") ? await compressImage(file) : file;
      const res = await uploadImage(tokenRef.current!, compressed);"""
    code = code.replace(old_upload, new_upload)

with open("app/chat/page.tsx", "w", encoding="utf-8") as f:
    f.write(code)

print("Compression patched.")

