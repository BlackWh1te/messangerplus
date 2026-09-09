const NGROK_API = 'https://iodine-napkin-handcraft.ngrok-free.dev'

export async function login(username: string, password: string) {
  const form = new URLSearchParams()
  form.append('username', username)
  form.append('password', password)

  const res = await fetch(`${NGROK_API}/login`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/x-www-form-urlencoded',
      'ngrok-skip-browser-warning': '1'
    },
    body: form.toString(),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Login failed' }))
    throw new Error(err.detail || 'Login failed')
  }
  return res.json()
}

export async function getMessages(token: string) {
  const res = await fetch(`${NGROK_API}/messages`, {
    headers: { 
      Authorization: `Bearer ${token}`,
      'ngrok-skip-browser-warning': '1'
    },
  })
  if (res.status === 401 && typeof window !== 'undefined') window.location.href = '/login'
  if (!res.ok) throw new Error('Failed to load messages')
  return res.json()
}

export async function getStatus(token: string) {
  const res = await fetch(`${NGROK_API}/status`, {
    headers: { 
      Authorization: `Bearer ${token}`,
      'ngrok-skip-browser-warning': '1'
    },
  })
  if (res.status === 401 && typeof window !== 'undefined') window.location.href = '/login'
  if (!res.ok) throw new Error('Failed to load status')
  return res.json()
}

export async function sendMessageHttp(token: string, content: string, nonce?: string) {
  const res = await fetch(`${NGROK_API}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'ngrok-skip-browser-warning': '1'
    },
    body: JSON.stringify({ content, nonce }),
  })
  if (res.status === 401 && typeof window !== 'undefined') window.location.href = '/login'
  if (!res.ok) throw new Error('Failed to send message')
  return res.json()
}

export function getWsUrl(token: string) {
  const wsBase = NGROK_API.replace(/^http/, 'ws')
  return `${wsBase}/ws/${token}`
}

export async function uploadImage(token: string, file: File) {
  const formData = new FormData()
  formData.append('file', file)

  const res = await fetch(`${NGROK_API}/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'ngrok-skip-browser-warning': '1'
    },
    body: formData
  })
  
  if (res.status === 401 && typeof window !== 'undefined') window.location.href = '/login'
  if (!res.ok) throw new Error('Upload failed')
  return res.json()
}
