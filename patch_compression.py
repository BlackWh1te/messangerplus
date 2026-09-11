import re

with open('app/chat/page.tsx', 'r', encoding='utf-8') as f:
    c = f.read()

# Replace handleImageUpload
img_up_orig = """  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      setBanner('Uploading image...')
      const res = await uploadImage(tokenRef.current!, file)
      await sendMessageHttp(tokenRef.current!, `[image:${res.url}]`)
      setBanner('')
    } catch (err: any) {
      setBanner(err.message || 'Image upload failed')
    }
  }"""

img_up_new = """  const compressImage = (file: File): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const img = new Image()
        img.onload = () => {
          const canvas = document.createElement('canvas')
          let { width, height } = img
          const MAX = 1200
          if (width > MAX || height > MAX) {
            if (width > height) {
              height = Math.round(height * (MAX / width))
              width = MAX
            } else {
              width = Math.round(width * (MAX / height))
              height = MAX
            }
          }
          canvas.width = width
          canvas.height = height
          const ctx = canvas.getContext('2d')
          ctx?.drawImage(img, 0, 0, width, height)
          canvas.toBlob(
            (blob) => blob ? resolve(blob) : reject(new Error('Canvas empty')),
            'image/jpeg',
            0.8
          )
        }
        img.onerror = () => reject(new Error('Invalid image'))
        img.src = e.target?.result as string
      }
      reader.onerror = () => reject(new Error('Read failed'))
      reader.readAsDataURL(file)
    })
  }

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      setBanner('Compressing image...')
      sendLog(tokenRef.current!, 'info', 'IMAGE_COMPRESS_START', { size: file.size })
      const compressed = await compressImage(file)
      const uploadFile = new File([compressed], file.name.replace(/\\.[^/.]+$/, "") + ".jpg", { type: 'image/jpeg' })
      sendLog(tokenRef.current!, 'info', 'IMAGE_COMPRESS_DONE', { old: file.size, new: uploadFile.size })
      
      setBanner('Uploading image...')
      const res = await uploadImage(tokenRef.current!, uploadFile)
      await sendMessageHttp(tokenRef.current!, `[image:${res.url}]`)
      setBanner('')
    } catch (err: any) {
      sendLog(tokenRef.current!, 'error', 'IMAGE_UPLOAD_FAILED', { err: String(err) })
      setBanner(err.message || 'Image upload failed')
    }
  }"""
c = c.replace(img_up_orig, img_up_new)

with open('app/chat/page.tsx', 'w', encoding='utf-8') as f:
    f.write(c)

print("Image compression patched")
