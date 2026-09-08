const NGROK_API = 'https://iodine-napkin-handcraft.ngrok-free.dev'

export async function login(username: string, password: string) {
  const form = new URLSearchParams()
  form.append('username', username)
  form.append('password', password)

  // Call Next.js proxy to bypass CORS
  const res = await fetch(`/api/proxy/login`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/x-www-form-urlencoded'
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
  // Call Next.js proxy to bypass CORS
  const res = await fetch(`/api/proxy/messages`, {
    headers: { 
      Authorization: `Bearer ${token}`
    },
  })
  if (!res.ok) throw new Error('Failed to load messages')
  return res.json()
}

export async function getStatus(token: string) {
  const res = await fetch(`/api/proxy/status`, {
    headers: { 
      Authorization: `Bearer ${token}`
    },
  })
  if (!res.ok) throw new Error('Failed to load status')
  return res.json()
}

export function getWsUrl(token: string) {
  // WebSockets bypass CORS naturally, so we connect directly to ngrok
  const wsBase = NGROK_API.replace(/^http/, 'ws')
  return `${wsBase}/ws/${token}`
}
