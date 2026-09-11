'use client'
import { useState, useEffect, useRef, useCallback, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { getMessages, getStatus, getWsUrl, sendMessageHttp, sendLog } from '@/lib/api'
import { gatherClientTelemetry } from '@/lib/telemetry'
import EmojiPicker, { Theme } from 'emoji-picker-react'
import { uploadImage } from '@/lib/api'
import CallPanel, { CallLaunchButtons, CallMode, CallState, IncomingCall } from './CallPanel'

const POLL_MS = 5000   // HTTP fallback poll every 5s
const PING_MS = 15000  // WS keepalive ping every 15s (tighter for Android)

const RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
}

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

interface CallSignal {
  type: 'call:offer' | 'call:answer' | 'call:ice' | 'call:end' | 'call:busy' | 'call:unavailable'
  from?: string
  callId?: string
  data?: {
    mode?: CallMode
    sdp?: RTCSessionDescriptionInit
    candidate?: RTCIceCandidateInit
    reason?: string
  }
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

function createCallId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `call-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach(track => track.stop())
}

function Ticks({ pending, delivered, read }: { pending?: boolean; delivered?: boolean | number; read?: boolean | number }) {
  if (pending) return (
    <span className="ml-1 inline-flex items-center">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <circle cx="5" cy="5" r="4" stroke="#99f6e4" strokeWidth="1.4" />
        <path d="M5 2.8V5L6.5 6" stroke="#99f6e4" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
  if (read) return (
    <span className="ml-1 inline-flex items-center">
      <svg width="16" height="10" viewBox="0 0 16 10" fill="none">
        <path d="M1 5L4.5 8.5L10 1.5" stroke="#5eead4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M6 5L9.5 8.5L15 1.5" stroke="#5eead4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
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


async function compressImage(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = event => {
      const img = new window.Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const MAX_WIDTH = 1200;
        const MAX_HEIGHT = 1200;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height = Math.round((height *= MAX_WIDTH / width));
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width = Math.round((width *= MAX_HEIGHT / height));
            height = MAX_HEIGHT;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(img, 0, 0, width, height);

        canvas.toBlob(blob => {
          if (blob) {
            resolve(new File([blob], file.name, { type: "image/jpeg" }));
          } else {
            resolve(file); // fallback
          }
        }, "image/jpeg", 0.7); // 70% quality
      };
      img.onerror = () => resolve(file); // fallback on error
    };
    reader.onerror = () => resolve(file);
  });
}

export default function ChatPage() {
  const router = useRouter()
  const [messages, setMessages] = useState<Message[]>([])
  const [partnerTyping, setPartnerTyping] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const [statuses, setStatuses] = useState<Record<string, UserStatus>>({})
  const [input, setInput] = useState('')
  const [username, setUsername] = useState('')
  const [connected, setConnected] = useState(false)
  const [banner, setBanner] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const [pickerMode, setPickerMode] = useState<'none' | 'emoji' | 'sticker'>('none')
  const [recentStickers, setRecentStickers] = useState<string[]>([])
  
  // OUTBOX SYSTEM: Guaranteed delivery
  const processOutbox = useCallback(async () => {
    if (typeof window === 'undefined') return
    try {
      const outboxJSON = localStorage.getItem('messenger_outbox')
      if (!outboxJSON) return
      const outbox = JSON.parse(outboxJSON) as { id: string, content: string }[]
      if (!outbox.length) return
      
      const token = tokenRef.current
      if (!token) return

      for (const item of outbox) {
        try {
          sendLog(token, 'info', 'OUTBOX_RETRY_START', { id: item.id, length: item.content.length })
          const msg = await sendMessageHttp(token, item.content, item.id)
          sendLog(token, 'info', 'OUTBOX_RETRY_SUCCESS', { id: item.id })
          // Success! Remove from outbox
          const currentOutbox = JSON.parse(localStorage.getItem('messenger_outbox') || '[]')
          localStorage.setItem('messenger_outbox', JSON.stringify(currentOutbox.filter((x: any) => x.id !== item.id)))
          
          setMessages(prev => {
            const alreadyReal = prev.find(m => m.id === msg.id)
            if (alreadyReal) return prev
            return prev.map(m => m.id === item.id ? msg : m)
          })
        } catch (e) {
          // Keep it in outbox, try again next time
        }
      }
    } catch (e) {}
  }, [])

  // Check outbox periodically
  useEffect(() => {
    const timer = setInterval(processOutbox, 3000)
    return () => clearInterval(timer)
  }, [processOutbox])

  const [callState, setCallState] = useState<CallState>('idle')
  const [callMode, setCallMode] = useState<CallMode>('audio')
  const [incomingCall, setIncomingCall] = useState<(IncomingCall & { offer: RTCSessionDescriptionInit }) | null>(null)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOff, setIsCameraOff] = useState(false)
  const [callSeconds, setCallSeconds] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([])
  const callIdRef = useRef('')
  const callStateRef = useRef<CallState>('idle')
  const callModeRef = useRef<CallMode>('audio')
  const callStartedAtRef = useRef<number | null>(null)
  const callTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
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
  localStreamRef.current = localStream
  remoteStreamRef.current = remoteStream

  function updateCallState(next: CallState) {
    callStateRef.current = next
    setCallState(next)
    if (next !== 'active') setCallSeconds(0)
    if (next === 'active' && callTimeoutRef.current) {
      clearTimeout(callTimeoutRef.current)
      callTimeoutRef.current = null
    }
  }

  function updateCallMode(next: CallMode) {
    callModeRef.current = next
    setCallMode(next)
  }

  function mediaErrorMessage(err: unknown) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      return 'Microphone or camera permission was blocked.'
    }
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      return 'No microphone or camera was found on this device.'
    }
    if (err instanceof Error) return err.message
    return 'Call could not start.'
  }

  async function getCallStream(mode: CallMode) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Calls need a secure browser with microphone support.')
    }

    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: mode === 'video'
        ? {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          }
        : false,
    })
  }

  function sendCallSignal(type: CallSignal['type'], data?: CallSignal['data'], callId = callIdRef.current) {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setBanner('Calls need a live connection. Wait a moment and try again.')
      return false
    }

    try {
      ws.send(JSON.stringify({ type, callId, data }))
      return true
    } catch (err: unknown) {
      setBanner(err instanceof Error ? err.message : 'Call signal failed.')
      return false
    }
  }

  async function flushPendingCandidates(pc = peerRef.current) {
    if (!pc || !pc.remoteDescription) return

    const candidates = pendingCandidatesRef.current.splice(0)
    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (err) {
        console.warn('Could not add queued ICE candidate', err)
      }
    }
  }

  function cleanupCall(sendEnd = false, reason = 'ended') {
    const callId = callIdRef.current
    if (sendEnd && callId) {
      sendCallSignal('call:end', { reason }, callId)
    }

    peerRef.current?.close()
    peerRef.current = null
    if (callTimeoutRef.current) {
      clearTimeout(callTimeoutRef.current)
      callTimeoutRef.current = null
    }
    pendingCandidatesRef.current = []
    callIdRef.current = ''
    callStartedAtRef.current = null
    stopStream(localStreamRef.current)
    stopStream(remoteStreamRef.current)
    setIncomingCall(null)
    setLocalStream(null)
    setRemoteStream(null)
    setIsMuted(false)
    setIsCameraOff(false)
    updateCallState('idle')
  }

  function createPeerConnection(callId: string) {
    const pc = new RTCPeerConnection(RTC_CONFIGURATION)
    peerRef.current = pc

    pc.onicecandidate = event => {
      if (event.candidate) {
        sendCallSignal('call:ice', { candidate: event.candidate.toJSON() }, callId)
      }
    }

    pc.ontrack = event => {
      const stream = event.streams[0] || remoteStreamRef.current || new MediaStream()
      if (!event.streams[0]) stream.addTrack(event.track)
      remoteStreamRef.current = stream
      setRemoteStream(stream)
      if (!callStartedAtRef.current) {
        callStartedAtRef.current = Date.now()
      }
      updateCallState('active')
      setBanner('')
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        if (!callStartedAtRef.current) callStartedAtRef.current = Date.now()
        updateCallState('active')
        setBanner('')
      } else if (['failed', 'closed'].includes(pc.connectionState) && callStateRef.current !== 'idle') {
        setBanner('Call disconnected.')
        cleanupCall(false)
      }
    }

    return pc
  }

  async function startCall(mode: CallMode) {
    if (callStateRef.current !== 'idle') return
    if (!connected) {
      setBanner('Calls need the live connection. Wait for the yellow dot to turn green.')
      return
    }

    const callId = createCallId()
    callIdRef.current = callId
    updateCallMode(mode)
    updateCallState('calling')
    setBanner('')

    try {
      const stream = await getCallStream(mode)
      localStreamRef.current = stream
      setLocalStream(stream)
      setIsMuted(false)
      setIsCameraOff(false)

      const pc = createPeerConnection(callId)
      stream.getTracks().forEach(track => pc.addTrack(track, stream))
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      if (!sendCallSignal('call:offer', { mode, sdp: offer }, callId)) {
        cleanupCall(false)
      } else {
        callTimeoutRef.current = setTimeout(() => {
          if (callStateRef.current === 'calling' && callIdRef.current === callId) {
            setBanner('No answer.')
            cleanupCall(true, 'missed')
          }
        }, 45000)
      }
    } catch (err: unknown) {
      cleanupCall(false)
      setBanner(mediaErrorMessage(err))
    }
  }

  async function acceptCall() {
    const call = incomingCall
    if (!call) return

    callIdRef.current = call.callId
    updateCallMode(call.mode)
    updateCallState('connecting')
    setBanner('')

    try {
      const stream = await getCallStream(call.mode)
      localStreamRef.current = stream
      setLocalStream(stream)
      setIsMuted(false)
      setIsCameraOff(false)

      const pc = createPeerConnection(call.callId)
      stream.getTracks().forEach(track => pc.addTrack(track, stream))
      await pc.setRemoteDescription(new RTCSessionDescription(call.offer))
      await flushPendingCandidates(pc)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      sendCallSignal('call:answer', { sdp: answer }, call.callId)
      setIncomingCall(null)
    } catch (err: unknown) {
      sendCallSignal('call:end', { reason: 'failed' }, call.callId)
      cleanupCall(false)
      setBanner(mediaErrorMessage(err))
    }
  }

  function rejectCall() {
    if (incomingCall) {
      sendCallSignal('call:end', { reason: 'declined' }, incomingCall.callId)
    }
    cleanupCall(false)
  }

  function endCall() {
    cleanupCall(true)
  }

  function toggleMute() {
    const next = !isMuted
    localStreamRef.current?.getAudioTracks().forEach(track => {
      track.enabled = !next
    })
    setIsMuted(next)
  }

  function toggleCamera() {
    const next = !isCameraOff
    localStreamRef.current?.getVideoTracks().forEach(track => {
      track.enabled = !next
    })
    setIsCameraOff(next)
  }

  async function handleCallSignal(signal: CallSignal) {
    if (!signal.callId) return

    if (signal.type === 'call:offer') {
      const sdp = signal.data?.sdp
      if (!sdp) return

      if (callStateRef.current !== 'idle') {
        sendCallSignal('call:busy', { reason: 'busy' }, signal.callId)
        return
      }

      const mode = signal.data?.mode === 'video' ? 'video' : 'audio'
      callIdRef.current = signal.callId
      updateCallMode(mode)
      setIncomingCall({
        callId: signal.callId,
        from: signal.from || 'Partner',
        mode,
        offer: sdp,
      })
      updateCallState('ringing')
      callTimeoutRef.current = setTimeout(() => {
        if (callStateRef.current === 'ringing' && callIdRef.current === signal.callId) {
          sendCallSignal('call:end', { reason: 'missed' }, signal.callId)
          cleanupCall(false)
        }
      }, 60000)
      setBanner('')
      return
    }

    if (signal.callId !== callIdRef.current) return

    if (signal.type === 'call:answer') {
      const sdp = signal.data?.sdp
      if (!sdp || !peerRef.current) return
      await peerRef.current.setRemoteDescription(new RTCSessionDescription(sdp))
      await flushPendingCandidates()
      updateCallState('connecting')
      return
    }

    if (signal.type === 'call:ice') {
      const candidate = signal.data?.candidate
      if (!candidate) return

      if (!peerRef.current || !peerRef.current.remoteDescription) {
        pendingCandidatesRef.current.push(candidate)
        return
      }

      try {
        await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (err) {
        console.warn('Could not add ICE candidate', err)
      }
      return
    }

    if (signal.type === 'call:busy') {
      cleanupCall(false)
      setBanner(`${signal.from || 'Partner'} is on another call.`)
      return
    }

    if (signal.type === 'call:unavailable') {
      cleanupCall(false)
      setBanner(`${signal.from || 'Partner'} is not connected for calls.`)
      return
    }

    if (signal.type === 'call:end') {
      cleanupCall(false)
      if (signal.data?.reason === 'declined') {
        setBanner('Call declined.')
      } else if (signal.data?.reason === 'missed') {
        setBanner('Missed call.')
      }
    }
  }

  // Merge new messages from HTTP poll
  const mergeMessages: (fetched: Message[]) => void = useCallback((fetched: Message[]): void => {
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



  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  
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
  }

  const connect = useCallback(() => {
    const token = tokenRef.current
    if (!token || destroyedRef.current) return
    if (reconnectRef.current) clearTimeout(reconnectRef.current)

    const wsUrl = getWsUrl(token)
    if (!wsUrl) {
      setConnected(false)
      return
    }

    const ws = new WebSocket(wsUrl)
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

        if (typeof payload.type === 'string' && payload.type.startsWith('call:')) {
          void handleCallSignal(payload as CallSignal)
          return
        }

        if (payload.type === 'typing') {
          if (payload.sender !== usernameRef.current) {
            setPartnerTyping(payload.state)
            if (payload.state) {
              setTimeout(() => setPartnerTyping(false), 5000)
            }
          }
          return
        }

        if (payload.type === 'message') {
          setPartnerTyping(false)
          const msg: Message = payload.data
          if (!seenIdsRef.current.has(msg.id as number)) {
            seenIdsRef.current.add(msg.id as number)
            setMessages(prev => {
              const without = prev.filter(m =>
                !(m.pending && m.sender === msg.sender && m.content === msg.content)
              )
              if (msg.sender !== usernameRef.current) {
                if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(100)
                try {
                  const audio = new window.Audio('data:audio/mp3;base64,//NExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')
                  audio.volume = 0.5
                  audio.play().catch(()=>{})
                } catch(e){}
              }
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
  }, [mergeMessages])

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
      setBanner('')
    }).catch((err) => {
      setBanner(err instanceof Error ? err.message : 'Could not load messages')
    })

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
      if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current)
      peerRef.current?.close()
      stopStream(localStreamRef.current)
      stopStream(remoteStreamRef.current)
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

  useEffect(() => {
    if (callState !== 'active') return

    const interval = setInterval(() => {
      if (callStartedAtRef.current) {
        setCallSeconds(Math.floor((Date.now() - callStartedAtRef.current) / 1000))
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [callState])

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files || e.target.files.length === 0) return
    const file = e.target.files[0]
    e.target.value = ''
    setIsUploading(true)
    setBanner('')
    try {
      const compressed = file.type.startsWith("image/") ? await compressImage(file) : file;
      const res = await uploadImage(tokenRef.current!, compressed);
      sendMessage(undefined, `[image:${res.url}]`)
    } catch (err: unknown) {
      setBanner(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setIsUploading(false)
    }
  }

  const startRecording = async () => {
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
          setIsUploading(true)
          setBanner('Uploading voice message...')
          const file = new File([audioBlob], 'voice.webm', { type: 'audio/webm' })
          const res = await uploadImage(tokenRef.current!, file as any)
          sendMessage(undefined, `[audio:${res.url}]`)
          setBanner('')
        } catch (err: any) {
          setBanner('Voice upload failed')
        } finally {
          setIsUploading(false)
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

    // Add to persistent outbox
    if (typeof window !== 'undefined') {
      try {
        const outbox = JSON.parse(localStorage.getItem('messenger_outbox') || '[]')
        if (!outbox.find((x: any) => x.id === optimisticId)) {
          outbox.push({ id: optimisticId, content: text })
          localStorage.setItem('messenger_outbox', JSON.stringify(outbox))
        }
      } catch (e) {}
    }

    try {
      setBanner('')
      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission()
      }

      // 100% reliable sending via HTTP POST (fixes Android WS drops and double-send bugs)
      const msg = await sendMessageHttp(token, text, optimisticId)
      seenIdsRef.current.add(msg.id as number)
      
      // Remove from persistent outbox
      if (typeof window !== 'undefined') {
        try {
          const outbox = JSON.parse(localStorage.getItem('messenger_outbox') || '[]')
          localStorage.setItem('messenger_outbox', JSON.stringify(outbox.filter((x: any) => x.id !== optimisticId)))
        } catch (e) {}
      }

      setMessages(prev => {
        // If WS echo beat us to it, the message is already real.
        const alreadyReal = prev.find(m => m.id === msg.id)
        if (alreadyReal) return prev
        
        // Otherwise replace the optimistic message
        return prev.map(m => m.id === optimisticId ? msg : m)
      })
    } catch (err: unknown) {
      sendLog(token, 'error', 'SEND_HTTP_FAILED', { id: optimisticId, error: err instanceof Error ? err.message : String(err) })
      // Mark as failed if HTTP request fails (network down)
      setMessages(prev => prev.map(m => m.id === optimisticId ? { ...m, failed: true, pending: false } : m))
      setBanner(err instanceof Error ? err.message : 'Message failed to send')
    }
  }

  // Auto-retry failed messages every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      if (connected || navigator.onLine) {
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
    if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current)
    cleanupCall(true)
    wsRef.current?.close()
    localStorage.clear()
    router.replace('/login')
  }

  const otherUser = Object.keys(statuses).find(u => u !== username) || 'Partner'
  const otherStatus = statuses[otherUser]
  const failedCount = messages.filter(m => m.failed).length

  return (
    <div className="relative flex flex-col h-[100dvh] w-full max-w-3xl mx-auto bg-[#171716] overflow-hidden">
      {/* Header */}
      <div className="bg-[#23211f]/95 backdrop-blur-md border-b border-zinc-800 px-4 py-2.5 flex items-center gap-3 shadow-sm z-10 shrink-0 sticky top-0" style={{ paddingTop: 'max(env(safe-area-inset-top), 0.625rem)' }}>
        <div className="w-10 h-10 rounded-full bg-teal-600 flex items-center justify-center text-white font-bold text-sm shrink-0 relative">
          {otherUser.slice(0, 2).toUpperCase()}
          {otherStatus?.online && (
            <span className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 rounded-full border-2 border-[#23211f]"></span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-white text-[15px] truncate leading-tight">{otherUser}</p>
          <p className="text-[11px] truncate leading-tight mt-0.5">
            {otherStatus?.online
              ? <span className="text-emerald-400 font-medium">online</span>
              : <span className="text-zinc-400">last seen {formatTime(otherStatus?.last_seen) || 'a while ago'}</span>
            }
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <CallLaunchButtons callState={callState} connected={connected} onStart={startCall} />
          <div className={`w-2 h-2 rounded-full transition-colors ${connected ? 'bg-emerald-500' : 'bg-amber-400 animate-pulse'}`} title={connected ? 'Live' : 'Polling'}></div>
          <button onClick={logout} className="text-[13px] font-medium text-zinc-400 hover:text-rose-300 transition-colors p-2 -mr-2">Logout</button>
        </div>
      </div>

      {partnerTyping && (
        <div className="bg-gray-800 text-gray-400 text-xs px-4 py-1 animate-pulse">
          {otherUser} is typing...
        </div>
      )}

      <CallPanel
        callState={callState}
        mode={callMode}
        peerName={incomingCall?.from || otherUser}
        incomingCall={incomingCall}
        localStream={localStream}
        remoteStream={remoteStream}
        seconds={callSeconds}
        muted={isMuted}
        cameraOff={isCameraOff}
        onAccept={acceptCall}
        onReject={rejectCall}
        onEnd={endCall}
        onToggleMute={toggleMute}
        onToggleCamera={toggleCamera}
      />

      {(banner || failedCount > 0) && (
        <div className="border-b border-amber-500/30 bg-amber-950/50 px-4 py-2 text-sm text-amber-100">
          {banner || `${failedCount} message${failedCount === 1 ? '' : 's'} waiting to resend`}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5 scroll-smooth overscroll-contain telegram-bg">
        {messages.length === 0 && (
          <div className="text-center text-zinc-400 mt-20 text-sm bg-[#23211f]/80 py-2 px-4 rounded-full w-fit mx-auto border border-zinc-800">
            No messages yet.
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
                <div className={`w-6 h-6 rounded-full bg-teal-700 flex items-center justify-center text-white text-[9px] font-bold shrink-0 shadow-sm ${showAvatar ? 'opacity-100' : 'opacity-0'}`}>
                  {msg.sender.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className={`max-w-[85%] md:max-w-[75%] flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                <div className={`flex items-center gap-1.5`}>
                  {isMe && msg.failed && (
                    <button 
                      onClick={() => sendMessage(undefined, msg.content, msg.id as string)}
                      className="text-rose-200 text-[11px] font-medium active:scale-95 bg-rose-950/70 px-2.5 py-1.5 rounded-full whitespace-nowrap shrink-0 touch-manipulation border border-rose-500/30"
                    >
                      Retry
                    </button>
                  )}
                  {(() => {
                    const imageMatch = msg.content.match(/^\[image:(.+)\]$/);
                    if (imageMatch) {
                      return (
                        <div className={`relative ${msg.pending ? 'opacity-75' : ''} ${msg.failed ? 'border border-rose-500/50 rounded-lg p-1 bg-rose-950/30' : ''}`}>
                          <img src={imageMatch[1].startsWith('/') ? '/api/proxy' + imageMatch[1] : imageMatch[1]} alt="image" className="max-w-[200px] sm:max-w-xs rounded-xl shadow-md" loading="lazy" />
                          <span className={`absolute bottom-2 right-2 text-[10px] whitespace-nowrap inline-flex items-center px-1.5 py-0.5 rounded-full bg-black/40 text-white/90 shadow-sm backdrop-blur-sm`}>
                            {formatTime(msg.timestamp)}
                            {isMe && <Ticks pending={msg.pending} delivered={msg.delivered} read={msg.read} />}
                          </span>
                        </div>
                      )
                    }
                    const audioMatch = msg.content.match(/^\[audio:(.+)\]$/);
                    if (audioMatch) {
                      return (
                        <div className={`relative ${msg.pending ? 'opacity-75' : ''} ${msg.failed ? 'border border-rose-500/50 rounded-lg p-1 bg-rose-950/30' : ''}`}>
                          <audio controls src={audioMatch[1].startsWith('/') ? '/api/proxy' + audioMatch[1] : audioMatch[1]} className="max-w-[200px] sm:max-w-[250px] h-10 rounded-full bg-white/10" />
                          <span className={`absolute -bottom-5 right-1 text-[10px] whitespace-nowrap inline-flex items-center px-1 text-zinc-400`}>
                            {formatTime(msg.timestamp)}
                            {isMe && <Ticks pending={msg.pending} delivered={msg.delivered} read={msg.read} />}
                          </span>
                        </div>
                      )
                    }
                    const stickerMatch = msg.content.match(/^\[sticker:(.+)\]$/);
                    if (stickerMatch) {
                      return (
                        <div className={`relative ${msg.pending ? 'opacity-75' : ''} ${msg.failed ? 'border border-rose-500/50 rounded-lg p-1 bg-rose-950/30' : ''}`}>
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
                          ? `bg-teal-600 text-white rounded-[18px] rounded-br-[4px] ${msg.pending ? 'opacity-75' : ''} ${msg.failed ? 'bg-rose-950/80 border border-rose-500/30' : ''}`
                          : 'bg-[#2c2a27] text-zinc-100 rounded-[18px] rounded-bl-[4px] border border-zinc-800/60'
                      }`}>
                        <span className="inline-block mr-1 whitespace-pre-wrap">{msg.content}</span>
                        <span className={`text-[10px] whitespace-nowrap inline-flex items-center translate-y-[2px] ${isMe ? 'text-teal-100' : 'text-zinc-400'}`}>
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


      {/* Input */}
      <div className="bg-[#23211f]/95 backdrop-blur-xl border-t border-zinc-800 shrink-0 z-30 relative" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}>
        <form onSubmit={sendMessage} className="flex gap-2 items-end px-3 pt-3">
          <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleUpload} />
          <button type="button" disabled={isUploading} onClick={() => fileInputRef.current?.click()} className="p-2 rounded-full transition-colors mb-[3px] touch-manipulation focus:outline-none shrink-0 flex items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50" title="Upload image">
            {isUploading ? <svg className="animate-spin w-5 h-5 text-teal-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-6 h-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>}
          </button>
          <button type="button" onClick={() => setPickerMode(pickerMode === 'emoji' ? 'none' : 'emoji')} className={`p-2 rounded-full transition-colors mb-[3px] touch-manipulation focus:outline-none shrink-0 flex items-center justify-center ${pickerMode === 'emoji' ? 'bg-teal-600 text-white' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'}`} title="Emojis">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-6 h-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
          </button>
          <button type="button" onClick={() => setPickerMode(pickerMode === 'sticker' ? 'none' : 'sticker')} className={`p-2 rounded-full transition-colors mb-[3px] touch-manipulation focus:outline-none shrink-0 flex items-center justify-center ${pickerMode === 'sticker' ? 'bg-teal-600 text-white' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'}`} title="Stickers">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-6 h-6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 2v20"/><path d="M2 12h20"/></svg>
          </button>
          <textarea
            value={input}
            onChange={handleInputChange}
            placeholder="Message"
            className="flex-1 bg-[#171716] border border-zinc-700 rounded-[20px] px-4 py-[10px] text-white focus:outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 text-[16px] placeholder-zinc-500 resize-none min-h-[44px] max-h-[120px]"
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
            type="button"
            onClick={isRecording ? stopRecording : startRecording}
            className={`p-3 rounded-full transition-colors mb-[3px] touch-manipulation focus:outline-none shrink-0 flex items-center justify-center ${isRecording ? 'bg-red-500 animate-pulse text-white' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'}`}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="22"/>
            </svg>
          </button>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); if(input.trim()) sendMessage(e as any); }}
            disabled={!input.trim() || isUploading}
            className="bg-teal-600 hover:bg-teal-500 disabled:opacity-40 disabled:bg-zinc-700 rounded-full w-[44px] h-[44px] flex items-center justify-center shrink-0 transition-colors active:scale-95 touch-manipulation mb-[2px]"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-[18px] h-[18px] text-white rotate-45 translate-x-[-1px] translate-y-[1px]">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </form>
      </div>
      {/* Picker Overlays */}
      <div className={`bg-[#23211f] z-20 shrink-0 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] overflow-hidden flex flex-col ${(pickerMode !== 'none') ? 'h-[300px] border-t border-zinc-800 pt-2' : 'h-0 border-t-0'}`}>
        {pickerMode === 'emoji' && (
          <div className="flex justify-center w-full max-h-[300px] overflow-hidden">
            <EmojiPicker theme={Theme.DARK} width="100%" onEmojiClick={(e) => setInput(prev => prev + e.emoji)} />
          </div>
        )}
        {pickerMode === 'sticker' && (
          <div className="flex flex-col gap-3 w-full max-h-[300px] overflow-y-auto custom-scrollbar px-1">
            {recentStickers.length > 0 && (
              <div>
                <div className="text-[10px] text-zinc-400 font-medium uppercase tracking-wider mb-1">Recent</div>
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
              <div className="text-[10px] text-zinc-400 font-medium uppercase tracking-wider mb-1">All Stickers</div>
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

    </div>
  )
}
