'use client'
import { useState, useEffect, useRef, useCallback, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { getMessages, getStatus, getWsUrl } from '@/lib/api'

interface Message {
  id: number | string  // string for optimistic messages
  sender: string
  content: string
  timestamp: string
  pending?: boolean
  failed?: boolean
}

interface UserStatus {
  online: boolean
  last_seen: string | null
}

// Robust timestamp parser — handles with/without Z, with/without offset
function formatTime(ts: string | null | undefined): string {
  if (!ts) return ''
  try {
    // If already has timezone info (Z or +/-) use as-is, else append Z
    const normalized = /Z|[+-]\d{2}:\d{2}$/.test(ts) ? ts : ts + 'Z'
    const d = new Date(normalized)
    if (isNaN(d.getTime())) return ''
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
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

  // Message queue for messages typed while offline
  const queueRef = useRef<string[]>([])
  // Track seen real IDs to avoid duplicates
  const seenIdsRef = useRef<Set<number>>(new Set())
  // Reconnect / ping timers
  const reconnectRef = useRef<NodeJS.Timeout | null>(null)
  const pingRef = useRef<NodeJS.Timeout | null>(null)
  // Prevent stale handlers after cleanup
  const destroyedRef = useRef(false)

  // Load messages safely without adding duplicates
  const loadMessages = useCallback((token: string) => {
    getMessages(token).then(msgs => {
      seenIdsRef.current = new Set(msgs.map((m: Message) => m.id as number))
      setMessages(msgs)
    }).catch(() => {
      localStorage.clear()
      router.replace('/login')
    })
  }, [router])

  // Drain the send queue once connected
  const drainQueue = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    while (queueRef.current.length > 0) {
      const text = queueRef.current.shift()!
      ws.send(JSON.stringify({ content: text }))
    }
  }, [])

  const connect = useCallback(() => {
    const token = tokenRef.current
    if (!token || destroyedRef.current) return

    // Clear any pending reconnect
    if (reconnectRef.current) clearTimeout(reconnectRef.current)

    const ws = new WebSocket(getWsUrl(token))
    wsRef.current = ws

    ws.onopen = () => {
      if (destroyedRef.current) { ws.close(); return }
      setConnected(true)

      // Reload history on reconnect to catch messages missed while offline
      loadMessages(token)

      // Drain any queued messages
      drainQueue()

      // Keep-alive ping every 20s
      if (pingRef.current) clearInterval(pingRef.current)
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 20000)
    }

    ws.onclose = () => {
      if (destroyedRef.current) return
      setConnected(false)
      if (pingRef.current) clearInterval(pingRef.current)
      // Reconnect after 3s
      reconnectRef.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => {
      ws.close() // triggers onclose which schedules reconnect
    }

    ws.onmessage = (e) => {
      if (destroyedRef.current) return
      try {
        const payload = JSON.parse(e.data)

        if (payload.type === 'message') {
          const msg: Message = payload.data
          // Dedup by real ID
          if (seenIdsRef.current.has(msg.id as number)) return
          seenIdsRef.current.add(msg.id as number)

          setMessages(prev => {
            // Remove matching optimistic message (same sender + content)
            const withoutOptimistic = prev.filter(m =>
              !(m.pending && m.sender === msg.sender && m.content === msg.content)
            )
            return [...withoutOptimistic, msg]
          })
        } else if (payload.type === 'status') {
          setStatuses(payload.data)
        }
        // pong / unknown types are ignored
      } catch { /* ignore malformed frames */ }
    }
  }, [loadMessages, drainQueue])

  useEffect(() => {
    const token = localStorage.getItem('token')
    const uname = localStorage.getItem('username')
    if (!token || !uname) { router.replace('/login'); return }

    destroyedRef.current = false
    tokenRef.current = token
    setUsername(uname)

    loadMessages(token)
    getStatus(token).then(setStatuses).catch(console.error)
    connect()

    return () => {
      destroyedRef.current = true
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (pingRef.current) clearInterval(pingRef.current)
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
      }
    }
  }, [router, connect, loadMessages])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function sendMessage(e: FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text) return

    const uname = username || localStorage.getItem('username') || ''

    // Show optimistic message immediately
    const optimisticId = `pending-${Date.now()}`
    const optimistic: Message = {
      id: optimisticId,
      sender: uname,
      content: text,
      timestamp: new Date().toISOString(),
      pending: true,
    }
    setMessages(prev => [...prev, optimistic])
    setInput('')

    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ content: text }))
    } else {
      // Queue for when we reconnect
      queueRef.current.push(text)
    }
  }

  function logout() {
    destroyedRef.current = true
    if (reconnectRef.current) clearTimeout(reconnectRef.current)
    if (pingRef.current) clearInterval(pingRef.current)
    wsRef.current?.close()
    localStorage.clear()
    router.replace('/login')
  }

  const otherUser = Object.keys(statuses).find(u => u !== username) || 'Partner'
  const otherStatus = statuses[otherUser]

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl">💬</span>
          <div>
            <h1 className="font-bold text-indigo-400">MessengerPlus</h1>
            <p className="text-xs text-gray-500">
              <span className={`inline-block w-2 h-2 rounded-full mr-1 transition-colors ${connected ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'}`}></span>
              {connected ? 'Connected' : 'Reconnecting…'}
            </p>
          </div>
        </div>

        {/* Partner status */}
        {otherStatus && (
          <div className="flex flex-col items-center text-center">
            <span className="text-sm font-semibold text-gray-300">{otherUser}</span>
            <span className="text-xs">
              {otherStatus.online
                ? <span className="text-green-400 font-medium flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400"></span>Online</span>
                : <span className="text-gray-500">Last seen: {formatTime(otherStatus.last_seen) || 'Never'}</span>
              }
            </span>
          </div>
        )}

        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">👤 {username}</span>
          <button onClick={logout} className="text-xs text-gray-500 hover:text-red-400 transition-colors">
            Logout
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-gray-600 mt-20">No messages yet. Say hi! 👋</div>
        )}
        {messages.map(msg => {
          const isMe = msg.sender === username
          return (
            <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-xs lg:max-w-md flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                {!isMe && (
                  <span className="text-xs text-gray-500 mb-1 px-1">{msg.sender}</span>
                )}
                <div className={`px-4 py-2 rounded-2xl text-sm transition-opacity ${
                  isMe
                    ? `bg-indigo-600 text-white rounded-br-sm ${msg.pending ? 'opacity-60' : 'opacity-100'}`
                    : 'bg-gray-800 text-gray-100 rounded-bl-sm'
                }`}>
                  {msg.content}
                </div>
                <span className="text-xs text-gray-600 mt-1 px-1 flex items-center gap-1">
                  {formatTime(msg.timestamp)}
                  {msg.pending && <span className="text-yellow-600">· sending…</span>}
                </span>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="bg-gray-900 border-t border-gray-800 px-4 py-3">
        {!connected && queueRef.current.length > 0 && (
          <p className="text-xs text-yellow-600 text-center mb-2">
            ⚠️ Reconnecting… {queueRef.current.length} message{queueRef.current.length > 1 ? 's' : ''} queued
          </p>
        )}
        <form onSubmit={sendMessage} className="flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={connected ? 'Type a message…' : 'Reconnecting — message will be queued…'}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-indigo-500 text-sm placeholder-gray-600"
            autoComplete="off"
            maxLength={2000}
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-xl px-4 py-2 font-semibold text-sm transition-colors"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  )
}
