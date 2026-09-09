'use client'
import { useState, useEffect, useRef, useCallback, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { getMessages, getStatus, getWsUrl, sendMessageHttp } from '@/lib/api'
import { gatherClientTelemetry } from '@/lib/telemetry'
import EmojiPicker, { Theme } from 'emoji-picker-react'
import { uploadImage } from '@/lib/api'

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
  nonce?: string
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

const STICKERS = [
  '1917-nom-fast.png', '2026-smoking-rat.jpg', '25111-shhh.png', '25939-is-grass-green.png',
  '27859-cronchycat.gif', '3067-li.jpg', '3503-hi.png', '3764-maxwell-4.gif', '3779-anime.png',
  '3837-yellow-joobi-neutral.png', '4156-.png', '4238-cat-pee.gif', '4424-noko-shake.png',
  '4588-kobeni.png', '5117-lol.png', '5649-rose.png', '59491-vegeta.png', '6543-stop-pls.png',
  '6835-deku.jpg', '7629-megumi.png', '7818-babyboo-meme-12.png', '8301-pepe-21.png',
  '8462-uh-oh.png', '8651-cat-reaction-3.png', '8697-sybau.png', '8709-gatos-memes.png',
  '9144-the-rock.png', '92746-uh-oh.png', '99333-absolute-cinema.png'
]

export default function ChatPage() {
  const router = useRouter()
  const [messages, setMessages] = useState<Message[]>([])
  const [statuses, setStatuses] = useState<Record<string, UserStatus>>({})
  const [input, setInput] = useState('')
  const [username, setUsername] = useState('')
  const [connected, setConnected] = useState(false)
  const [pickerMode, setPickerMode] = useState<'none' | 'emoji' | 'sticker'>('none')
  const [recentStickers, setRecentStickers] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  // Merge new messages from HTTP poll
  const mergeMessages = useCallback((fetched: Message[]) => {
    setMessages(prev => {
      let changed = false
      const updated = [...prev]

      for (const msg of fetched) {
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
          // Find matching pending message by nonce
          const optIdx = updated.findIndex(m => m.pending && (m.id === msg.nonce || (m.content === msg.content && m.sender === msg.sender)))
          if (optIdx !== -1) {
             updated[optIdx] = msg
          } else {
             updated.push(msg)
          }
          seenIdsRef.current.add(id)
          changed = true
        }
      }
      return changed ? updated.sort((a,b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()) : prev
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
          // Notify or Read
          if (msg.sender !== usernameRef.current) {
            if (document.visibilityState === 'visible') {
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'read' }))
            } else {
              if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
                const n = new Notification(`Message from ${msg.sender}`, { body: msg.content })
                n.onclick = () => { window.focus(); n.close() }
              }
            }
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
        if (document.visibilityState === 'visible' && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'read' }))
        }
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
    try {
      const saved = localStorage.getItem('recentStickers')
      if (saved) setRecentStickers(JSON.parse(saved))
    } catch {}

    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'default') {
        Notification.requestPermission()
      }
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files || e.target.files.length === 0) return
    const file = e.target.files[0]
    e.target.value = '' // reset
    try {
      const res = await uploadImage(tokenRef.current!, file)
      sendMessage(undefined, `[image:${res.url}]`)
    } catch (err) {
      alert('Upload failed: ' + err)
    }
  }

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
      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission()
      }

      // 100% reliable sending via HTTP POST (fixes Android WS drops and double-send bugs)
      const msg = await sendMessageHttp(token, text, optimisticId)
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
      <div className="bg-gray-900/85 backdrop-blur-md border-b border-gray-800/50 px-4 py-2.5 flex items-center gap-3 shadow-sm z-10 shrink-0 sticky top-0" style={{ paddingTop: 'max(env(safe-area-inset-top), 0.625rem)' }}>
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
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5 scroll-smooth overscroll-contain telegram-bg">
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
                  {(() => {
                    const imageMatch = msg.content.match(/^\[image:(.+)\]$/);
                    if (imageMatch) {
                      return (
                        <div className={`relative ${msg.pending ? 'opacity-75' : ''} ${msg.failed ? 'border border-red-500/50 rounded-lg p-1 bg-red-900/20' : ''}`}>
                          <img src={imageMatch[1].startsWith('/') ? 'https://iodine-napkin-handcraft.ngrok-free.dev' + imageMatch[1] : imageMatch[1]} alt="image" className="max-w-[200px] sm:max-w-xs rounded-xl shadow-md" loading="lazy" />
                          <span className={`absolute bottom-2 right-2 text-[10px] whitespace-nowrap inline-flex items-center px-1.5 py-0.5 rounded-full bg-black/40 text-white/90 shadow-sm backdrop-blur-sm`}>
                            {formatTime(msg.timestamp)}
                            {isMe && <Ticks pending={msg.pending} delivered={msg.delivered} read={msg.read} />}
                          </span>
                        </div>
                      )
                    }
                    const stickerMatch = msg.content.match(/^\[sticker:(.+)\]$/);
                    if (stickerMatch) {
                      return (
                        <div className={`relative ${msg.pending ? 'opacity-75' : ''} ${msg.failed ? 'border border-red-500/50 rounded-lg p-1 bg-red-900/20' : ''}`}>
                          <img src={`/stickers/${stickerMatch[1]}`} alt="sticker" className="w-32 h-32 object-contain drop-shadow-md" loading="lazy" />
                          <span className={`absolute bottom-1 right-2 text-[10px] whitespace-nowrap inline-flex items-center px-1.5 py-0.5 rounded-full bg-black/40 text-white/90 shadow-sm backdrop-blur-sm`}>
                            {formatTime(msg.timestamp)}
                            {isMe && <Ticks pending={msg.pending} delivered={msg.delivered} read={msg.read} />}
                          </span>
                        </div>
                      )
                    }

                    return (
                      <div className={`px-3 py-2 text-[15px] leading-[1.4] break-words shadow-sm relative ${
                        isMe
                          ? `bg-indigo-600 text-white rounded-[18px] rounded-br-[4px] ${msg.pending ? 'opacity-75' : ''} ${msg.failed ? 'bg-red-900/80 border border-red-500/30' : ''}`
                          : 'bg-gray-800 text-gray-100 rounded-[18px] rounded-bl-[4px]'
                      }`}>
                        <span className="inline-block mr-1 whitespace-pre-wrap">{msg.content}</span>
                        <span className={`text-[10px] whitespace-nowrap inline-flex items-center translate-y-[2px] ${isMe ? 'text-indigo-200' : 'text-gray-400'}`}>
                          {formatTime(msg.timestamp)}
                          {isMe && <Ticks pending={msg.pending} delivered={msg.delivered} read={msg.read} />}
                        </span>
                      </div>
                    )
                  })()}
                </div>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} className="h-2" />
      </div>


      {/* Picker Overlays */}
      <div className={`bg-gray-900/95 backdrop-blur-xl border-t border-gray-800/50 pt-2 pb-3 px-2 z-20 shrink-0 shadow-[0_-10px_30px_rgba(0,0,0,0.5)] absolute left-0 right-0 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${(pickerMode !== 'none') ? 'bottom-[60px] opacity-100 pointer-events-auto' : 'bottom-[40px] opacity-0 pointer-events-none'}`}>
        {pickerMode === 'emoji' && (
          <div className="flex justify-center w-full max-h-[300px] overflow-hidden">
            <EmojiPicker theme={Theme.DARK} width="100%" onEmojiClick={(e) => setInput(prev => prev + e.emoji)} />
          </div>
        )}
        {pickerMode === 'sticker' && (
          <div className="flex flex-col gap-3 w-full max-h-[300px] overflow-y-auto custom-scrollbar px-1">
            {recentStickers.length > 0 && (
              <div>
                <div className="text-[10px] text-gray-400 font-medium uppercase tracking-wider mb-1">Recent</div>
                <div className="flex gap-2.5 overflow-x-auto pb-2 custom-scrollbar items-center">
                  {recentStickers.map(s => (
                    <img 
                      key={s} 
                      src={`/stickers/${s}`} 
                      alt="sticker" 
                      className="w-[72px] h-[72px] object-contain cursor-pointer hover:scale-110 hover:-translate-y-1 active:scale-95 transition-all shrink-0 drop-shadow-md" 
                      onClick={() => {
                        sendMessage(undefined, `[sticker:${s}]`)
                        setPickerMode('none')
                        setRecentStickers(prev => {
                          const next = [s, ...prev.filter(x => x !== s)].slice(0, 10)
                          localStorage.setItem('recentStickers', JSON.stringify(next))
                          return next
                        })
                      }} 
                    />
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="text-[10px] text-gray-400 font-medium uppercase tracking-wider mb-1">All Stickers</div>
              <div className="flex gap-2.5 overflow-x-auto pb-2 custom-scrollbar items-center flex-wrap">
                {STICKERS.map(s => (
                  <img 
                    key={s} 
                    src={`/stickers/${s}`} 
                    alt="sticker" 
                    className="w-[72px] h-[72px] object-contain cursor-pointer hover:scale-110 hover:-translate-y-1 active:scale-95 transition-all shrink-0 drop-shadow-md" 
                    onClick={() => {
                      sendMessage(undefined, `[sticker:${s}]`)
                      setPickerMode('none')
                      setRecentStickers(prev => {
                        const next = [s, ...prev.filter(x => x !== s)].slice(0, 10)
                        localStorage.setItem('recentStickers', JSON.stringify(next))
                        return next
                      })
                    }} 
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="bg-gray-900/85 backdrop-blur-xl border-t border-gray-800/50 shrink-0 z-30 relative" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}>
        <form onSubmit={sendMessage} className="flex gap-2 items-end px-3 pt-3">
          <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleUpload} />
          <button type="button" onClick={() => fileInputRef.current?.click()} className="p-2 rounded-full transition-colors mb-[3px] touch-manipulation focus:outline-none shrink-0 flex items-center justify-center text-gray-400 hover:bg-gray-800 hover:text-gray-200" title="Upload Image">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-6 h-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          </button>
          <button type="button" onClick={() => setPickerMode(pickerMode === 'emoji' ? 'none' : 'emoji')} className={`p-2 rounded-full transition-colors mb-[3px] touch-manipulation focus:outline-none shrink-0 flex items-center justify-center ${pickerMode === 'emoji' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}`} title="Emojis">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-6 h-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
          </button>
          <button type="button" onClick={() => setPickerMode(pickerMode === 'sticker' ? 'none' : 'sticker')} className={`p-2 rounded-full transition-colors mb-[3px] touch-manipulation focus:outline-none shrink-0 flex items-center justify-center ${pickerMode === 'sticker' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}`} title="Stickers">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-6 h-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 2v20"/><path d="M2 12h20"/></svg>
          </button>
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
