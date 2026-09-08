const API = 'https://iodine-napkin-handcraft.ngrok-free.dev'

export async function login(username: string, password: string) {
  const form = new URLSearchParams()
  form.append('username', username)
  form.append('password', password)

  const res = await fetch(`${API}/login`, {
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
  const res = await fetch(`${API}/messages`, {
    headers: { 
      Authorization: `Bearer ${token}`,
      'ngrok-skip-browser-warning': '1'
    },
  })
  if (!res.ok) throw new Error('Failed to load messages')
  return res.json()
}

export function getWsUrl(token: string) {
  const wsBase = API.replace(/^http/, 'ws')
  return `${wsBase}/ws/${token}`
}
