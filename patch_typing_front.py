import re

with open('app/chat/page.tsx', 'r', encoding='utf-8') as f:
    c = f.read()

# 1. State for typing
state_hook = """  const [messages, setMessages] = useState<Message[]>([])
  const [partnerTyping, setPartnerTyping] = useState(false)"""
c = c.replace("  const [messages, setMessages] = useState<Message[]>([])", state_hook)

# 2. Handle typing WS
ws_typing_handle = """      if (data.type === 'message') {
        setMessages(prev => {
          if (prev.find(m => m.id === data.data.id)) return prev
          return [...prev, data.data]
        })
      }"""
ws_typing_handle_new = """      if (data.type === 'typing') {
        if (data.sender !== usernameRef.current) {
          setPartnerTyping(data.state)
          // auto-clear after 5s if we miss a stop event
          if (data.state) {
            setTimeout(() => setPartnerTyping(false), 5000)
          }
        }
      } else if (data.type === 'message') {
        setPartnerTyping(false) // clear typing on message
        setMessages(prev => {
          if (prev.find(m => m.id === data.data.id)) return prev
          return [...prev, data.data]
        })
      }"""
c = c.replace(ws_typing_handle, ws_typing_handle_new)

# 3. Send typing on change
send_typing = """  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'typing', state: true }))
      
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
      typingTimeoutRef.current = setTimeout(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'typing', state: false }))
        }
      }, 2000)
    }
  }"""
c = c.replace("  const connect = useCallback(() => {", send_typing + "\n\n  const connect = useCallback(() => {")

# 4. Use handleInputChange
c = c.replace("onChange={(e) => setInput(e.target.value)}", "onChange={handleInputChange}")

# 5. Display typing indicator below header
header_end = """        </CallLaunchButtons>
      </header>"""
typing_ui = """        </CallLaunchButtons>
      </header>
      {partnerTyping && (
        <div className="bg-gray-800 text-gray-400 text-xs px-4 py-1 animate-pulse">
          partner is typing...
        </div>
      )}"""
c = c.replace(header_end, typing_ui)

with open('app/chat/page.tsx', 'w', encoding='utf-8') as f:
    f.write(c)

print("Typing patched frontend")
