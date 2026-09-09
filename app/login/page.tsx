'use client'
import { useState, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { login } from '@/lib/api'

export default function LoginPage() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const data = await login(username, password)
      localStorage.setItem('token', data.access_token)
      localStorage.setItem('username', data.username)
      router.push('/chat')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-[100dvh] flex items-center justify-center px-4 py-8 bg-[#171716]">
      <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-[#23211f] p-6 shadow-2xl">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-teal-600 text-lg font-bold text-white shadow-lg">
          MP
        </div>
        <h1 className="mb-1 text-center text-2xl font-semibold text-zinc-50">MessengerPlus</h1>
        <p className="mb-6 text-center text-sm text-zinc-400">Sign in to continue</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">Username</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-[#171716] px-4 py-3 text-base text-white outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
              placeholder="user1"
              required
              autoComplete="username"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-[#171716] px-4 py-3 text-base text-white outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
              placeholder="Password"
              required
              autoComplete="current-password"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-rose-500/50 bg-rose-950/40 px-4 py-3 text-sm text-rose-100">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="min-h-12 w-full rounded-lg bg-teal-600 px-4 py-3 font-semibold text-white transition hover:bg-teal-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
