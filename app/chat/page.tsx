'use client'
import { useState, useEffect, useRef, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { getMessages, getStatus, getWsUrl } from '@/lib/api'

interface Message {
  id: number
  sender: string
  content: string
  timestamp: string
}

interface UserStatus {
  online: boolean
  last_seen: string | null
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

  useEffect(() => {
    const token = localStorage.getItem('token')
    const uname = localStorage.getItem('username')
    if (!token || !uname) { router.replace('/login'); return }
    setUsername(uname)

    // Load history
    getMessages(token).then(setMessages).catch(() => {
      localStorage.clear()
      router.replace('/login')
    })

    // Load initial status
    getStatus(token).then(setStatuses).catch(console.error)

    let ws: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout;
    let pingTimer: NodeJS.Timeout;

    function connect() {
      if (!token) return;
      ws = new WebSocket(getWsUrl(token))
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        // Keep connection alive through proxies (like ngrok) and mobile networks
        pingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }))
          }
        }, 20000)
      }

      ws.onclose = () => {
        setConnected(false)
        clearInterval(pingTimer)
        // Auto-reconnect every 3 seconds if connection drops
        reconnectTimer = setTimeout(connect, 3000)
      }

      ws.onerror = () => {
        ws?.close()
      }

      ws.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data)
          if (payload.type === 'message') {
            setMessages(prev => [...prev, payload.data])
          } else if (payload.type === 'status') {
            setStatuses(payload.data)
          } else {
            // Fallback for old format if any
            if (payload.id && payload.content) {
              setMessages(prev => [...prev, payload])
            }
          }
        } catch (err) {}
      }
    }

    connect()

    return () => {
      clearTimeout(reconnectTimer)
      clearInterval(pingTimer)
      if (ws) {
        ws.onclose = null // prevent reconnect loop on unmount
        ws.close()
      }
    }
  }, [router])

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function sendMessage(e: FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({ content: text }))
    setInput('')
  }

  function logout() {
    wsRef.current?.close()
    localStorage.clear()
    router.replace('/login')
  }

  function formatTime(ts: string) {
    return new Date(ts + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  // Find the other user's status
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
              <span className={`inline-block w-2 h-2 rounded-full mr-1 ${connected ? 'bg-green-500' : 'bg-red-500'}`}></span>
              {connected ? 'Connected' : 'Reconnecting…'}
            </p>
          </div>
        </div>
        
        {/* Partner Status */}
        {otherStatus && (
          <div className="flex flex-col items-center justify-center text-center mx-auto">
            <span className="text-sm font-semibold text-gray-300">{otherUser}</span>
            <span className="text-xs">
              {otherStatus.online ? (
                <span className="text-green-400 font-medium">Online</span>
              ) : (
                <span className="text-gray-500">
                  Last seen: {otherStatus.last_seen ? formatTime(otherStatus.last_seen) : 'Never'}
                </span>
              )}
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
              <div className={`max-w-xs lg:max-w-md ${isMe ? 'items-end' : 'items-start'} flex flex-col`}>
                {!isMe && (
                  <span className="text-xs text-gray-500 mb-1 px-1">{msg.sender}</span>
                )}
                <div className={`px-4 py-2 rounded-2xl text-sm ${
                  isMe
                    ? 'bg-indigo-600 text-white rounded-br-sm'
                    : 'bg-gray-800 text-gray-100 rounded-bl-sm'
                }`}>
                  {msg.content}
                </div>
                <span className="text-xs text-gray-600 mt-1 px-1">{formatTime(msg.timestamp)}</span>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="bg-gray-900 border-t border-gray-800 px-4 py-3">
        <form onSubmit={sendMessage} className="flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Type a message…"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2 text-white focus:outline-none focus:border-indigo-500 text-sm"
            autoComplete="off"
            maxLength={2000}
          />
          <button
            type="submit"
            disabled={!connected || !input.trim()}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-xl px-4 py-2 font-semibold text-sm transition-colors"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  )
}
