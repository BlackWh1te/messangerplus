'use client'

import { useEffect, useRef } from 'react'

export type CallMode = 'audio' | 'video'
export type CallState = 'idle' | 'calling' | 'ringing' | 'connecting' | 'active'

export interface IncomingCall {
  callId: string
  from: string
  mode: CallMode
}

interface CallPanelProps {
  callState: CallState
  mode: CallMode
  peerName: string
  incomingCall: IncomingCall | null
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  seconds: number
  muted: boolean
  cameraOff: boolean
  onAccept: () => void
  onReject: () => void
  onEnd: () => void
  onToggleMute: () => void
  onToggleCamera: () => void
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${minutes}:${secs.toString().padStart(2, '0')}`
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-5 w-5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.77.62 2.61a2 2 0 0 1-.45 2.11L8 9.72a16 16 0 0 0 6.28 6.28l1.28-1.28a2 2 0 0 1 2.11-.45c.84.29 1.71.5 2.61.62A2 2 0 0 1 22 16.92z" />
    </svg>
  )
}

function VideoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-5 w-5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  )
}

function MicIcon({ off = false }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-5 w-5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v4" />
      <path d="M8 23h8" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  )
}

function EndIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-5 w-5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.68 13.31a16 16 0 0 0 2.64 0l1.19 2.38a2 2 0 0 0 2.22 1.04l3.46-.86a2 2 0 0 0 1.5-2.25C20.86 8.05 16.76 5 12 5S3.14 8.05 2.31 13.62a2 2 0 0 0 1.5 2.25l3.46.86a2 2 0 0 0 2.22-1.04l1.19-2.38z" />
    </svg>
  )
}

function ControlButton({
  title,
  children,
  onClick,
  disabled,
  tone = 'neutral',
}: {
  title: string
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: 'neutral' | 'good' | 'danger'
}) {
  const toneClass = {
    neutral: 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-600',
    good: 'bg-emerald-600 text-white hover:bg-emerald-500 disabled:bg-zinc-900 disabled:text-zinc-600',
    danger: 'bg-rose-600 text-white hover:bg-rose-500 disabled:bg-zinc-900 disabled:text-zinc-600',
  }[tone]

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition active:scale-95 disabled:cursor-not-allowed ${toneClass}`}
    >
      {children}
    </button>
  )
}

export function CallLaunchButtons({
  callState,
  connected,
  onStart,
}: {
  callState: CallState
  connected: boolean
  onStart: (mode: CallMode) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <ControlButton title="Voice call" onClick={() => onStart('audio')} disabled={!connected || callState !== 'idle'} tone="good">
        <PhoneIcon />
      </ControlButton>
      <ControlButton title="Video call" onClick={() => onStart('video')} disabled={!connected || callState !== 'idle'} tone="neutral">
        <VideoIcon />
      </ControlButton>
    </div>
  )
}

export default function CallPanel({
  callState,
  mode,
  peerName,
  incomingCall,
  localStream,
  remoteStream,
  seconds,
  muted,
  cameraOff,
  onAccept,
  onReject,
  onEnd,
  onToggleMute,
  onToggleCamera,
}: CallPanelProps) {
  const remoteAudioRef = useRef<HTMLAudioElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const callLabel = mode === 'video' ? 'Video call' : 'Voice call'

  useEffect(() => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = mode === 'audio' ? remoteStream : null
      remoteAudioRef.current.play().catch(() => {})
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = mode === 'video' ? remoteStream : null
      remoteVideoRef.current.play().catch(() => {})
    }
  }, [mode, remoteStream])

  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream
      localVideoRef.current.play().catch(() => {})
    }
  }, [localStream])

  return (
    <>
      <audio ref={remoteAudioRef} autoPlay playsInline />

      {callState !== 'idle' && callState !== 'ringing' && (
        <div className="border-b border-zinc-800 bg-[#171716] px-3 py-3">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            {mode === 'video' && (
              <div className="relative h-32 w-24 shrink-0 overflow-hidden rounded-lg border border-zinc-800 bg-black sm:h-40 sm:w-32">
                <video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
                {localStream && (
                  <video ref={localVideoRef} autoPlay muted playsInline className="absolute bottom-1 right-1 h-14 w-10 rounded border border-white/20 object-cover" />
                )}
              </div>
            )}

            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-zinc-100">{peerName}</div>
              <div className="text-xs text-zinc-400">
                {callState === 'active' ? `${callLabel} ${formatDuration(seconds)}` : callState === 'calling' ? 'Calling...' : 'Connecting...'}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <ControlButton title={muted ? 'Unmute' : 'Mute'} onClick={onToggleMute}>
                <MicIcon off={muted} />
              </ControlButton>
              {mode === 'video' && (
                <ControlButton title={cameraOff ? 'Camera on' : 'Camera off'} onClick={onToggleCamera}>
                  <VideoIcon />
                </ControlButton>
              )}
              <ControlButton title="End call" onClick={onEnd} tone="danger">
                <EndIcon />
              </ControlButton>
            </div>
          </div>
        </div>
      )}

      {callState === 'ringing' && incomingCall && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-[#23211f] p-5 text-center shadow-2xl">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-teal-600 text-lg font-bold text-white">
              {incomingCall.from.slice(0, 2).toUpperCase()}
            </div>
            <div className="text-lg font-semibold text-white">{incomingCall.from}</div>
            <div className="mt-1 text-sm text-zinc-400">{incomingCall.mode === 'video' ? 'Incoming video call' : 'Incoming voice call'}</div>
            <div className="mt-6 flex justify-center gap-4">
              <ControlButton title="Decline" onClick={onReject} tone="danger">
                <EndIcon />
              </ControlButton>
              <ControlButton title="Answer" onClick={onAccept} tone="good">
                {incomingCall.mode === 'video' ? <VideoIcon /> : <PhoneIcon />}
              </ControlButton>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
