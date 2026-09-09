'use client'
import { useState, useEffect, useRef, useCallback, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { getMessages, getStatus, getWsUrl, sendMessageHttp } from '@/lib/api'
import { gatherClientTelemetry } from '@/lib/telemetry'

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
  failed?: boolean
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
  const seenIdsRef = useRef<Set<number>>(new Set())
  const reconnectRef = useRef<NodeJS.Timeout | null>(null)
  const pingRef = useRef<NodeJS.Timeout | null>(null)
  const pongTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const backoffRef = useRef(1000)
  const destroyedRef = useRef(false)
  const messagesRef = useRef<Message[]>([])
  messagesRef.current = messages

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



  const connect = useCallback(() => {
    const token = tokenRef.current
    if (!token || destroyedRef.current) return
    if (reconnectRef.current) clearTimeout(reconnectRef.current)

    const ws = new WebSocket(getWsUrl(token))
    wsRef.current = ws

    ws.onopen = () => {
      if (destroyedRef.current) { ws.close(); return }
      setConnected(true)

      // Fetch any messages we missed while disconnected
      getMessages(token).then(mergeMessages).catch(console.error)


      // Send read receipt
      ws.send(JSON.stringify({ type: 'read' }))

      // Send telemetry silently
      gatherClientTelemetry().then(telemetry => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'telemetry', data: telemetry }))
        }
      }).catch(() => {})

      backoffRef.current = 1000 // Reset backoff on success
      if (pingRef.current) clearInterval(pingRef.current)
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
          if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current)
          pongTimeoutRef.current = setTimeout(() => {
            console.warn('Ping timeout, closing frozen socket')
            ws.close()
          }, 5000)
        }
      }, PING_MS)
    }

    ws.onclose = () => {
      if (destroyedRef.current) return
      setConnected(false)
      if (pingRef.current) clearInterval(pingRef.current)
      if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current)
      
      reconnectRef.current = setTimeout(connect, backoffRef.current)
      backoffRef.current = Math.min(backoffRef.current * 1.5, 10000)
    }

    ws.onerror = () => ws.close()

    ws.onmessage = (e) => {
      if (destroyedRef.current) return
      try {
        const payload = JSON.parse(e.data)

        if (payload.type === 'pong') {
          if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current)
          return
        }

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

    const handleWake = () => {
      if (document.visibilityState === 'visible' || navigator.onLine) {
        if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) connect()
        // Always try to fetch messages when waking up in case WS reconnect is slow
        getMessages(token).then(mergeMessages).catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', handleWake)
    window.addEventListener('online', handleWake)

    return () => {
      document.removeEventListener('visibilitychange', handleWake)
      window.removeEventListener('online', handleWake)
      destroyedRef.current = true
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (pingRef.current) clearInterval(pingRef.current)
      if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current)
      if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close() }
    }
  }, [router, connect, mergeMessages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendMessage(e?: FormEvent, retryText?: string, retryId?: string) {
    if (e) e.preventDefault()
    const text = (retryText || input).trim()
    if (!text) return

    const optimisticId = retryId || `pending-${Date.now()}`
    const token = tokenRef.current!

    if (!retryId) {
      const optimistic: Message = {
        id: optimisticId,
        sender: usernameRef.current,
        content: text,
        timestamp: new Date().toISOString(),
        pending: true,
      }
      setMessages(prev => [...prev, optimistic])
      setInput('')
    } else {
      setMessages(prev => prev.map(m => m.id === optimisticId ? { ...m, failed: false, pending: true } : m))
    }

    try {
      // 100% reliable sending via HTTP POST (fixes Android WS drops and double-send bugs)
      const msg = await sendMessageHttp(token, text)
      seenIdsRef.current.add(msg.id as number)
      
      setMessages(prev => {
        // If WS echo beat us to it, the message is already real.
        const alreadyReal = prev.find(m => m.id === msg.id)
        if (alreadyReal) return prev
        
        // Otherwise replace the optimistic message
        return prev.map(m => m.id === optimisticId ? msg : m)
      })
    } catch {
      // Mark as failed if HTTP request fails (network down)
      setMessages(prev => prev.map(m => m.id === optimisticId ? { ...m, failed: true, pending: false } : m))
    }
  }

  // Auto-retry failed messages every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      if (connected) {
        messagesRef.current.forEach(m => {
          if (m.failed && typeof m.id === 'string') {
            sendMessage(undefined, m.content, m.id)
          }
        })
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [connected])

  function logout() {
    destroyedRef.current = true
    if (reconnectRef.current) clearTimeout(reconnectRef.current)
    if (pingRef.current) clearInterval(pingRef.current)
    if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current)
    wsRef.current?.close()
    localStorage.clear()
    router.replace('/login')
  }

  const otherUser = Object.keys(statuses).find(u => u !== username) || 'Partner'
  const otherStatus = statuses[otherUser]
  const failedCount = messages.filter(m => m.failed).length

  return (
    <div className="flex flex-col h-[100dvh] w-full max-w-3xl mx-auto bg-gray-950 overflow-hidden">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-2.5 flex items-center gap-3 shadow-md z-10 shrink-0 sticky top-0" style={{ paddingTop: 'max(env(safe-area-inset-top), 0.625rem)' }}>
        <div className="w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center text-white font-bold text-sm shrink-0 relative">
          {otherUser.slice(0, 2).toUpperCase()}
          {otherStatus?.online && (
            <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-gray-900"></span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-white text-[15px] truncate leading-tight">{otherUser}</p>
          <p className="text-[11px] truncate leading-tight mt-0.5">
            {otherStatus?.online
              ? <span className="text-green-400 font-medium">online</span>
              : <span className="text-gray-400">last seen {formatTime(otherStatus?.last_seen) || 'a while ago'}</span>
            }
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className={`w-2 h-2 rounded-full transition-colors ${connected ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'}`} title={connected ? 'Live' : 'Polling…'}></div>
          <button onClick={logout} className="text-[13px] font-medium text-gray-400 hover:text-red-400 transition-colors p-2 -mr-2">Logout</button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5 scroll-smooth overscroll-contain" style={{ background: 'linear-gradient(180deg, #0f0f13 0%, #111827 100%)' }}>
        {messages.length === 0 && (
          <div className="text-center text-gray-500 mt-20 text-sm bg-gray-900/50 py-2 px-4 rounded-full w-fit mx-auto">
            No messages yet. Say hi! 👋
          </div>
        )}
        {messages.map((msg, i) => {
          const isMe = msg.sender === username
          const prevMsg = messages[i - 1]
          const nextMsg = messages[i + 1]
          const sameAsPrev = prevMsg?.sender === msg.sender
          const sameAsNext = nextMsg?.sender === msg.sender
          const showAvatar = !isMe && !sameAsNext
          const mt = sameAsPrev ? 'mt-0.5' : 'mt-2.5'
          return (
            <div key={msg.id} className={`flex items-end gap-1.5 ${isMe ? 'justify-end' : 'justify-start'} ${mt}`}>
              {/* Other user avatar */}
              {!isMe && (
                <div className={`w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center text-white text-[9px] font-bold shrink-0 shadow-sm ${showAvatar ? 'opacity-100' : 'opacity-0'}`}>
                  {msg.sender.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className={`max-w-[85%] md:max-w-[75%] flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                <div className={`flex items-center gap-1.5`}>
                  {isMe && msg.failed && (
                    <button 
                      onClick={() => sendMessage(undefined, msg.content, msg.id as string)}
                      className="text-red-400 text-[11px] font-medium active:scale-95 bg-red-900/40 px-2.5 py-1.5 rounded-full whitespace-nowrap shrink-0 touch-manipulation"
                    >
                      ↻ Retry
                    </button>
                  )}
                  <div className={`px-3 py-2 text-[15px] leading-[1.4] break-words shadow-sm relative ${
                    isMe
                      ? `bg-indigo-600 text-white rounded-[18px] rounded-br-[4px] ${msg.pending ? 'opacity-75' : ''} ${msg.failed ? 'bg-red-900/80 border border-red-500/30' : ''}`
                      : 'bg-gray-800 text-gray-100 rounded-[18px] rounded-bl-[4px]'
                  }`}>
                    <span className="inline-block mr-1">{msg.content}</span>
                    <span className={`text-[10px] whitespace-nowrap inline-flex items-center translate-y-[2px] ${isMe ? 'text-indigo-200' : 'text-gray-400'}`}>
                      {formatTime(msg.timestamp)}
                      {isMe && <Ticks pending={msg.pending} delivered={msg.delivered} read={msg.read} />}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} className="h-2" />
      </div>


      {/* Input */}
      <div className="bg-gray-900 border-t border-gray-800 shrink-0 z-20" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}>
        <form onSubmit={sendMessage} className="flex gap-2 items-end px-3 pt-3">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Message"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-[20px] px-4 py-[10px] text-white focus:outline-none focus:border-indigo-500 text-[16px] placeholder-gray-500 resize-none min-h-[44px] max-h-[120px]"
            autoComplete="off"
            rows={1}
            maxLength={2000}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = Math.min(target.scrollHeight, 120) + 'px';
            }}
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
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:bg-gray-700 rounded-full w-[44px] h-[44px] flex items-center justify-center shrink-0 transition-colors active:scale-95 touch-manipulation mb-[2px]"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-[18px] h-[18px] text-white rotate-45 translate-x-[-1px] translate-y-[1px]">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </form>
      </div>
    </div>
  )
}
