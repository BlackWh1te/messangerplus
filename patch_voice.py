import re

with open('app/chat/page.tsx', 'r', encoding='utf-8') as f:
    c = f.read()

# 1. Add state for recording
state_hook = """  const [isTyping, setIsTyping] = useState(false)
  const [partnerTyping, setPartnerTyping] = useState(false)"""

state_new = """  const [partnerTyping, setPartnerTyping] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])"""
c = c.replace(state_hook, state_new)
c = c.replace('  const [partnerTyping, setPartnerTyping] = useState(false)\n  const [partnerTyping, setPartnerTyping] = useState(false)', '  const [partnerTyping, setPartnerTyping] = useState(false)') # Dedupe

# 2. Render Audio tag for [audio:...]
render_msg_orig = """    if (content.startsWith('[image:') && content.endsWith(']')) {
      const url = content.slice(7, -1)
      return <img src={`/api/proxy${url}`} alt="Uploaded image" className="max-w-full rounded-md object-contain max-h-64 cursor-pointer" />
    }"""
render_msg_new = """    if (content.startsWith('[image:') && content.endsWith(']')) {
      const url = content.slice(7, -1)
      return <img src={`/api/proxy${url}`} alt="Uploaded image" className="max-w-full rounded-md object-contain max-h-64 cursor-pointer" />
    }
    if (content.startsWith('[audio:') && content.endsWith(']')) {
      const url = content.slice(7, -1)
      return <audio controls src={`/api/proxy${url}`} className="max-w-[200px] h-10 rounded-full" />
    }"""
c = c.replace(render_msg_orig, render_msg_new)

# 3. Add Voice Recording Functions
fns_orig = """  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {"""
fns_new = """  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      audioChunksRef.current = []
      
      recorder.ondataavailable = e => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }
      
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        setIsRecording(false)
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        if (audioBlob.size < 1000) return // too short
        
        try {
          setBanner('Uploading voice message...')
          const file = new File([audioBlob], 'voice.webm', { type: 'audio/webm' })
          const res = await uploadImage(tokenRef.current!, file as any)
          await sendMessageHttp(tokenRef.current!, `[audio:${res.url}]`)
          setBanner('')
        } catch (err: any) {
          setBanner('Voice upload failed')
        }
      }
      
      recorder.start()
      mediaRecorderRef.current = recorder
      setIsRecording(true)
    } catch (e) {
      setBanner('Microphone permission denied')
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
    }
  }

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {"""
c = c.replace(fns_orig, fns_new)

# 4. Add Sound & Vibration on incoming message
ws_msg_orig = """        setPartnerTyping(false) // clear typing on message
        setMessages(prev => {
          if (prev.find(m => m.id === data.data.id)) return prev
          return [...prev, data.data]
        })"""
ws_msg_new = """        setPartnerTyping(false) // clear typing on message
        setMessages(prev => {
          if (prev.find(m => m.id === data.data.id)) return prev
          // Vibrate and Play Sound
          if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(100)
          try {
            const audio = new Audio('data:audio/mp3;base64,//NExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')
            audio.volume = 0.5
            audio.play().catch(()=>{})
          } catch(e){}
          return [...prev, data.data]
        })"""
c = c.replace(ws_msg_orig, ws_msg_new)

# 5. Add UI Microphone button
mic_btn_orig = """            <button
              type="submit"
              disabled={!input.trim()}
              className="p-3 bg-teal-500 text-white rounded-full hover:bg-teal-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >"""
mic_btn_new = """            <button
              type="button"
              onClick={isRecording ? stopRecording : startRecording}
              className={`p-3 rounded-full transition-colors flex-shrink-0 ${isRecording ? 'bg-red-500 animate-pulse text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="22"/>
              </svg>
            </button>
            <button
              type="submit"
              disabled={!input.trim() && !isRecording}
              className="p-3 bg-teal-500 text-white rounded-full hover:bg-teal-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >"""
c = c.replace(mic_btn_orig, mic_btn_new)

with open('app/chat/page.tsx', 'w', encoding='utf-8') as f:
    f.write(c)
print("Voice patched")
