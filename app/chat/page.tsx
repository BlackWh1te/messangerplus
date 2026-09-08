'use client'
import { useState, useEffect, useRef, useCallback, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { getMessages, getStatus, getWsUrl } from '@/lib/api'

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

// Telegram/WhatsApp-style checkmarks
function Ticks({ pending, delivered, read }: { pending?: boolean; delivered?: boolean | number; read?: boolean | number }) {
  if (pending) {
    // Clock icon = queued / sending
    return <span className="ml-1 text-gray-400 text-xs">🕐</span>
  }
  if (read) {
    // Double blue ticks
    return (
      <span className="ml-1 inline-flex">
        <svg width="16" height="11" viewBox="0 0 16 11" fill="none">
          <path d="M1 5.5L5 9.5L11 2" stroke="#60a5fa" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M6 5.5L10 9.5L15 2" stroke="#60a5fa" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </span>
    )
  }
  if (delivered) {
    // Double gray ticks
    return (
      <span className="ml-1 inline-flex">
        <svg width="16" height="11" viewBox="0 0 16 11" fill="none">
          <path d="M1 5.5L5 9.5L11 2" stroke="#9ca3af" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M6 5.5L10 9.5L15 2" stroke="#9ca3af" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </span>
    )
  }
  // Single gray tick = sent to server
  return (
    <span className="ml-1 inline-flex">
      <svg width="10" height="11" viewBox="0 0 10 11" fill="none">
        <path d="M1 5.5L4 9L9 1" stroke="#9ca3af" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
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
  const destroyedRef = useRef(false)
  const readSentRef = useRef(false)

  const loadMessages = useCallback((token: string) => {
    getMessages(token).then((msgs: Message[]) => {
      seenIdsRef.current = new Set(msgs.map(m => m.id as number))
      setMessages(msgs)
      // Send read receipt after loading
      setTimeout(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN && !readSentRef.current) {
          wsRef.current.send(JSON.stringify({ type: 'read' }))
          readSentRef.current = true
        }
      }, 500)
    }).catch(() => {
      localStorage.clear()
      router.replace('/login')
    })
  }, [router])

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
    if (reconnectRef.current) clearTimeout(reconnectRef.current)

    const ws = new WebSocket(getWsUrl(token))
    wsRef.current = ws

    ws.onopen = () => {
      if (destroyedRef.current) { ws.close(); return }
      setConnected(true)
      readSentRef.current = false
      loadMessages(token)
      drainQueue()

      if (pingRef.current) clearInterval(pingRef.current)
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, 20000)
    }

    ws.onclose = () => {
      if (destroyedRef.current) return
      setConnected(false)
      if (pingRef.current) clearInterval(pingRef.current)
      reconnectRef.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => ws.close()

    ws.onmessage = (e) => {
      if (destroyedRef.current) return
      try {
        const payload = JSON.parse(e.data)

        if (payload.type === 'message') {
          const msg: Message = payload.data
          if (seenIdsRef.current.has(msg.id as number)) return
          seenIdsRef.current.add(msg.id as number)
          setMessages(prev => {
            const withoutOptimistic = prev.filter(m =>
              !(m.pending && m.sender === msg.sender && m.content === msg.content)
            )
            return [...withoutOptimistic, msg]
          })
          // If it's from someone else, send read receipt
          if (msg.sender !== usernameRef.current && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'read' }))
          }
        } else if (payload.type === 'status') {
          setStatuses(payload.data)
        } else if (payload.type === 'delivered') {
          // Mark message as delivered
          setMessages(prev => prev.map(m =>
            (m.id === payload.id) ? { ...m, delivered: true } : m
          ))
        } else if (payload.type === 'read') {
          // Mark all our messages as read
          setMessages(prev => prev.map(m =>
            (m.sender === usernameRef.current && !m.pending) ? { ...m, read: true } : m
          ))
        }
      } catch { /* ignore malformed frames */ }
    }
  }, [loadMessages, drainQueue])

  useEffect(() => {
    const token = localStorage.getItem('token')
    const uname = localStorage.getItem('username')
    if (!token || !uname) { router.replace('/login'); return }

    destroyedRef.current = false
    tokenRef.current = token
    usernameRef.current = uname
    setUsername(uname)

    loadMessages(token)
    getStatus(token).then(setStatuses).catch(console.error)
    connect()

    return () => {
      destroyedRef.current = true
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (pingRef.current) clearInterval(pingRef.current)
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close() }
    }
  }, [router, connect, loadMessages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function sendMessage(e: FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text) return

    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      sender: usernameRef.current,
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
  const pendingCount = queueRef.current.length

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto bg-gray-950">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center gap-3 shadow-sm">
        {/* Avatar */}
        <div className="w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center text-white font-bold text-sm shrink-0 relative">
          {otherUser.slice(0, 2).toUpperCase()}
          {otherStatus?.online && (
            <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-400 rounded-full border-2 border-gray-900"></span>
          )}
        </div>

        {/* Name + status */}
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-white text-sm truncate">{otherUser}</p>
          <p className="text-xs truncate">
            {otherStatus?.online
              ? <span className="text-green-400">online</span>
              : <span className="text-gray-500">last seen {formatTime(otherStatus?.last_seen) || 'a while ago'}</span>
            }
          </p>
        </div>

        {/* Connection indicator */}
        <div className="flex items-center gap-2 shrink-0">
          {!connected && (
            <span className="text-xs text-yellow-500 animate-pulse">reconnecting…</span>
          )}
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'}`}></div>
          <button onClick={logout} className="text-xs text-gray-500 hover:text-red-400 ml-2 transition-colors">
            Logout
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1" style={{ background: 'linear-gradient(180deg, #0f0f13 0%, #111827 100%)' }}>
        {messages.length === 0 && (
          <div className="text-center text-gray-600 mt-20 text-sm">No messages yet. Say hi! 👋</div>
        )}
        {messages.map((msg, i) => {
          const isMe = msg.sender === username
          const prevMsg = messages[i - 1]
          const showName = !isMe && (!prevMsg || prevMsg.sender !== msg.sender)
          return (
            <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'} ${i > 0 && messages[i-1].sender === msg.sender ? 'mt-0.5' : 'mt-3'}`}>
              <div className={`max-w-[75%] flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                {showName && (
                  <span className="text-xs text-indigo-400 mb-1 px-2">{msg.sender}</span>
                )}
                <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed break-words ${
                  isMe
                    ? `bg-indigo-600 text-white rounded-br-md ${msg.pending ? 'opacity-70' : ''}`
                    : 'bg-gray-800 text-gray-100 rounded-bl-md'
                }`}>
                  <span>{msg.content}</span>
                  {/* Timestamp + ticks inside bubble for sent messages */}
                  <span className={`text-[10px] ml-2 align-bottom inline-flex items-center gap-0.5 ${isMe ? 'text-indigo-300' : 'text-gray-500'}`}>
                    {formatTime(msg.timestamp)}
                    {isMe && (
                      <Ticks
                        pending={msg.pending}
                        delivered={msg.delivered}
                        read={msg.read}
                      />
                    )}
                  </span>
                </div>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Queue warning */}
      {!connected && pendingCount > 0 && (
        <div className="bg-yellow-900/30 border-t border-yellow-800 px-4 py-2 text-xs text-yellow-400 text-center">
          ⚠️ Offline — {pendingCount} message{pendingCount > 1 ? 's' : ''} will send when reconnected
        </div>
      )}

      {/* Input */}
      <div className="bg-gray-900 border-t border-gray-800 px-3 py-3">
        <form onSubmit={sendMessage} className="flex gap-2 items-end">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={connected ? 'Message…' : 'Offline — will queue…'}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-2xl px-4 py-2.5 text-white focus:outline-none focus:border-indigo-500 text-sm placeholder-gray-600 resize-none"
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
