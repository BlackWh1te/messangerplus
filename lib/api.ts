const RAW_API_URL = (process.env.NEXT_PUBLIC_API_URL || '').trim().replace(/\/+$/, '')
const RAW_WS_URL = (process.env.NEXT_PUBLIC_WS_URL || '').trim().replace(/\/+$/, '')
const API_PROXY = '/api/proxy'

function apiUrl(path: string) {
  return `${API_PROXY}/${path.replace(/^\/+/, '')}`
}

async function errorMessage(res: Response, fallback: string) {
  const err = await res.json().catch(() => null)
  const detail = err?.detail || err?.message || fallback
  return err?.error_code ? `${detail} (${err.error_code})` : detail
}

function redirectOnUnauthorized(res: Response) {
  if (res.status === 401 && typeof window !== 'undefined') {
    localStorage.removeItem('token')
    window.location.href = '/login'
  }
}

export async function login(username: string, password: string) {
  const form = new URLSearchParams()
  form.append('username', username)
  form.append('password', password)

  const res = await fetch(apiUrl('login'), {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString(),
  })

  if (!res.ok) {
    throw new Error(await errorMessage(res, 'Login failed'))
  }
  return res.json()
}

export async function getMessages(token: string) {
  const res = await fetch(apiUrl('messages'), {
    headers: { 
      Authorization: `Bearer ${token}`
    },
  })
  redirectOnUnauthorized(res)
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load messages'))
  return res.json()
}

export async function getStatus(token: string) {
  const res = await fetch(apiUrl('status'), {
    headers: { 
      Authorization: `Bearer ${token}`
    },
  })
  redirectOnUnauthorized(res)
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load status'))
  return res.json()
}

export async function sendMessageHttp(token: string, content: string, nonce?: string) {
  const res = await fetch(apiUrl('send'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ content, nonce }),
  })
  redirectOnUnauthorized(res)
  if (!res.ok) throw new Error(await errorMessage(res, 'Failed to send message'))
  return res.json()
}

export function getWsUrl(token: string) {
  const wsSource = RAW_WS_URL || RAW_API_URL
  if (!wsSource) return ''
  const wsBase = wsSource.replace(/^http/i, 'ws')
  return `${wsBase}/ws/${token}`
}

export async function uploadImage(token: string, file: File) {
  const formData = new FormData()
  formData.append('file', file)

  const res = await fetch(apiUrl('upload'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: formData
  })
  
  redirectOnUnauthorized(res)
  if (!res.ok) throw new Error(await errorMessage(res, 'Upload failed'))
  return res.json()
}
