'use client'
import { useState, useEffect, useRef, useCallback, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { getMessages, getStatus, getWsUrl, sendMessageHttp } from '@/lib/api'

const POLL_MS = 5000   // HTTP fallback poll every 5s
const PING_MS = 15000  // WS keepalive ping every 15s (tighter for Android)

interface Message {
  id: number | string
  sender: string
  content: string
  timestamp: string
  delivered?: boolean | number
  read?: boolean | number
  pending?: boolean
}

interface UserStatus {
  online: boolean
  last_seen: string | null
}

function formatTime(ts: string | null | undefined): string {
  if (!ts) return ''
  try {
    const normalized = /Z|[+-]\d{2}:\d{2}$/.test(ts) ? ts : ts + 'Z'
    const d = new Date(normalized)
    if (isNaN(d.getTime())) return ''
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

function Ticks({ pending, delivered, read }: { pending?: boolean; delivered?: boolean | number; read?: boolean | number }) {
  if (pending) return <span className="text-indigo-300 text-[10px] ml-1">🕐</span>
  if (read) return (
    <span className="ml-1 inline-flex items-center">
      <svg width="16" height="10" viewBox="0 0 16 10" fill="none">
        <path d="M1 5L4.5 8.5L10 1.5" stroke="#60a5fa" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M6 5L9.5 8.5L15 1.5" stroke="#60a5fa" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </span>
  )
  if (delivered) return (
    <span className="ml-1 inline-flex items-center">
      <svg width="16" height="10" viewBox="0 0 16 10" fill="none">
        <path d="M1 5L4.5 8.5L10 1.5" stroke="#a3a3a3" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M6 5L9.5 8.5L15 1.5" stroke="#a3a3a3" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </span>
  )
  return (
    <span className="ml-1 inline-flex items-center">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M1 5L4 8.5L9 1.5" stroke="#a3a3a3" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </span>
  )
}

export default function ChatPage() {
  const router = useRouter()
  const [messages, setMessages] = useState<Message[]>([])
  const [statuses, setStatuses] = useState<Record<string, UserStatus>>({})
  const [input, setInput] = useState('')
  const [username, setUsername] = useState('')
  const [connected, setConnected] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const tokenRef = useRef<string | null>(null)
  const usernameRef = useRef<string>('')
  const queueRef = useRef<string[]>([])
  const seenIdsRef = useRef<Set<number>>(new Set())
  const reconnectRef = useRef<NodeJS.Timeout | null>(null)
  const pingRef = useRef<NodeJS.Timeout | null>(null)
  const pollRef = useRef<NodeJS.Timeout | null>(null)
  const destroyedRef = useRef(false)

  // Merge new messages from HTTP poll — no duplicates, no flash
  const mergeMessages = useCallback((fresh: Message[]) => {
    setMessages(prev => {
      let changed = false
      const updated = [...prev]

      for (const msg of fresh) {
        const id = msg.id as number
        if (seenIdsRef.current.has(id)) {
          // Update delivery/read status on existing message
          const idx = updated.findIndex(m => m.id === id)
          if (idx !== -1) {
            const m = updated[idx]
            if (m.delivered !== msg.delivered || m.read !== msg.read) {
              updated[idx] = { ...m, delivered: msg.delivered, read: msg.read }
              changed = true
            }
          }
        } else {
          seenIdsRef.current.add(id)
          // Remove matching optimistic
          const optIdx = updated.findIndex(m => m.pending && m.content === msg.content && m.sender === msg.sender)
          if (optIdx !== -1) updated.splice(optIdx, 1)
          updated.push(msg)
          changed = true
        }
      }
      return changed ? updated : prev
    })
  }, [])

  const startPolling = useCallback((token: string) => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      if (destroyedRef.current) return
      try {
        const msgs = await getMessages(token)
        mergeMessages(msgs)
      } catch { /* network error — silently ignore */ }
    }, POLL_MS)
  }, [mergeMessages])

  const connect = useCallback(() => {
    const token = tokenRef.current
    if (!token || destroyedRef.current) return
    if (reconnectRef.current) clearTimeout(reconnectRef.current)

    const ws = new WebSocket(getWsUrl(token))
    wsRef.current = ws

    ws.onopen = () => {
      if (destroyedRef.current) { ws.close(); return }
      setConnected(true)

      // Drain queued messages
      while (queueRef.current.length > 0) {
        const text = queueRef.current.shift()!
        ws.send(JSON.stringify({ content: text }))
      }

      // Send read receipt
      ws.send(JSON.stringify({ type: 'read' }))

      if (pingRef.current) clearInterval(pingRef.current)
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, PING_MS)
    }

    ws.onclose = () => {
      if (destroyedRef.current) return
      setConnected(false)
      if (pingRef.current) clearInterval(pingRef.current)
      // Reconnect every 3s
      reconnectRef.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => ws.close()

    ws.onmessage = (e) => {
      if (destroyedRef.current) return
      try {
        const payload = JSON.parse(e.data)

        if (payload.type === 'message') {
          const msg: Message = payload.data
          if (!seenIdsRef.current.has(msg.id as number)) {
            seenIdsRef.current.add(msg.id as number)
            setMessages(prev => {
              const without = prev.filter(m =>
                !(m.pending && m.sender === msg.sender && m.content === msg.content)
              )
              return [...without, msg]
            })
          }
          // Send read receipt for incoming messages
          if (msg.sender !== usernameRef.current && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'read' }))
          }
        } else if (payload.type === 'status') {
          setStatuses(payload.data)
        } else if (payload.type === 'delivered') {
          setMessages(prev => prev.map(m =>
            m.id === payload.id ? { ...m, delivered: true } : m
          ))
        } else if (payload.type === 'read') {
          setMessages(prev => prev.map(m =>
            m.sender === usernameRef.current && !m.pending ? { ...m, read: true } : m
          ))
        }
      } catch { /* ignore bad frames */ }
    }
  }, [])

  useEffect(() => {
    const token = localStorage.getItem('token')
    const uname = localStorage.getItem('username')
    if (!token || !uname) { router.replace('/login'); return }

    destroyedRef.current = false
    tokenRef.current = token
    usernameRef.current = uname
    setUsername(uname)

    // Initial load
    getMessages(token).then((msgs: Message[]) => {
      seenIdsRef.current = new Set(msgs.map((m: Message) => m.id as number))
      setMessages(msgs)
    }).catch(() => { localStorage.clear(); router.replace('/login') })

    getStatus(token).then(setStatuses).catch(console.error)

    connect()
    startPolling(token)

    return () => {
      destroyedRef.current = true
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (pingRef.current) clearInterval(pingRef.current)
      if (pollRef.current) clearInterval(pollRef.current)
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close() }
    }
  }, [router, connect, startPolling])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendMessage(e: FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text) return

    const optimisticId = `pending-${Date.now()}`
    const optimistic: Message = {
      id: optimisticId,
      sender: usernameRef.current,
      content: text,
      timestamp: new Date().toISOString(),
      pending: true,
    }
    setMessages(prev => [...prev, optimistic])
    setInput('')

    const token = tokenRef.current!

    // Try WebSocket first (instant), always back up with HTTP POST
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ content: text }))
      // HTTP POST confirms delivery even if WS echo is lost
      try { await sendMessageHttp(token, text) } catch { /* WS already sent it */ }
    } else {
      // WS unavailable — use HTTP POST as primary
      try {
        const msg = await sendMessageHttp(token, text)
        // Replace optimistic with real message
        seenIdsRef.current.add(msg.id as number)
        setMessages(prev => prev.map(m => m.id === optimisticId ? msg : m))
      } catch {
        // Mark as failed
        setMessages(prev => prev.map(m => m.id === optimisticId ? { ...m, failed: true } : m))
      }
    }
  }

  function logout() {
    destroyedRef.current = true
    if (reconnectRef.current) clearTimeout(reconnectRef.current)
    if (pingRef.current) clearInterval(pingRef.current)
    if (pollRef.current) clearInterval(pollRef.current)
    wsRef.current?.close()
    localStorage.clear()
    router.replace('/login')
  }

  const otherUser = Object.keys(statuses).find(u => u !== username) || 'Partner'
  const otherStatus = statuses[otherUser]
  const pendingCount = queueRef.current.length

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto bg-gray-950">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center gap-3 shadow-sm">
        <div className="w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center text-white font-bold text-sm shrink-0 relative">
          {otherUser.slice(0, 2).toUpperCase()}
          {otherStatus?.online && (
            <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-400 rounded-full border-2 border-gray-900"></span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-white text-sm truncate">{otherUser}</p>
          <p className="text-xs truncate">
            {otherStatus?.online
              ? <span className="text-green-400">online</span>
              : <span className="text-gray-500">last seen {formatTime(otherStatus?.last_seen) || 'a while ago'}</span>
            }
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className={`w-2 h-2 rounded-full transition-colors ${connected ? 'bg-green-500' : 'bg-gray-500 animate-pulse'}`} title={connected ? 'Live' : 'Polling…'}></div>
          <button onClick={logout} className="text-xs text-gray-500 hover:text-red-400 transition-colors">Logout</button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5" style={{ background: 'linear-gradient(180deg, #0f0f13 0%, #111827 100%)' }}>
        {messages.length === 0 && (
          <div className="text-center text-gray-600 mt-20 text-sm">No messages yet. Say hi! 👋</div>
        )}
        {messages.map((msg, i) => {
          const isMe = msg.sender === username
          const prevMsg = messages[i - 1]
          const nextMsg = messages[i + 1]
          const sameAsPrev = prevMsg?.sender === msg.sender
          const sameAsNext = nextMsg?.sender === msg.sender
          const showAvatar = !isMe && !sameAsNext
          const mt = sameAsPrev ? 'mt-0.5' : 'mt-3'
          return (
            <div key={msg.id} className={`flex items-end gap-2 ${isMe ? 'justify-end' : 'justify-start'} ${mt}`}>
              {/* Other user avatar */}
              {!isMe && (
                <div className={`w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-[10px] font-bold shrink-0 ${showAvatar ? 'opacity-100' : 'opacity-0'}`}>
                  {msg.sender.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className={`max-w-[72%] flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                <div className={`px-3 py-2 text-sm leading-relaxed break-words ${
                  isMe
                    ? `bg-indigo-600 text-white rounded-2xl rounded-br-md ${msg.pending ? 'opacity-60' : ''}`
                    : 'bg-gray-800 text-gray-100 rounded-2xl rounded-bl-md'
                }`}>
                  <span>{msg.content}</span>
                  <span className={`text-[10px] ml-2 whitespace-nowrap inline-flex items-center ${isMe ? 'text-indigo-300' : 'text-gray-500'}`}>
                    {formatTime(msg.timestamp)}
                    {isMe && <Ticks pending={msg.pending} delivered={msg.delivered} read={msg.read} />}
                  </span>
                </div>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Offline queue banner */}
      {!connected && pendingCount > 0 && (
        <div className="bg-gray-800 border-t border-gray-700 px-4 py-2 text-xs text-gray-400 text-center">
          📶 Reconnecting — {pendingCount} message{pendingCount > 1 ? 's' : ''} queued
        </div>
      )}

      {/* Input */}
      <div className="bg-gray-900 border-t border-gray-800 px-3 py-3">
        <form onSubmit={sendMessage} className="flex gap-2 items-center">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Message…"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-2xl px-4 py-2.5 text-white focus:outline-none focus:border-indigo-500 text-sm placeholder-gray-600"
            autoComplete="off"
            maxLength={2000}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (input.trim()) sendMessage(e as any)
              }
            }}
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-full w-10 h-10 flex items-center justify-center shrink-0 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-white rotate-45">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </form>
      </div>
    </div>
  )
}
