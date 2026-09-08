'use client'
import { useState, useEffect, useRef, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { getMessages, getWsUrl } from '@/lib/api'

interface Message {
  id: number
  sender: string
  content: string
  timestamp: string
}

export default function ChatPage() {
  const router = useRouter()
  const [messages, setMessages] = useState<Message[]>([])
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

    // Connect WebSocket
    const ws = new WebSocket(getWsUrl(token))
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = (e) => {
      const msg: Message = JSON.parse(e.data)
      setMessages(prev => [...prev, msg])
    }

    return () => { ws.close() }
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
