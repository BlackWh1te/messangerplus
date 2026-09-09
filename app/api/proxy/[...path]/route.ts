import { NextRequest, NextResponse } from 'next/server'

const API = (process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '')

function targetUrl(req: NextRequest, path: string[]) {
  const currentUrl = new URL(req.url)
  const backendPath = path.map(segment => encodeURIComponent(segment)).join('/')
  return `${API}/${backendPath}${currentUrl.search}`
}

async function proxy(req: NextRequest, { params }: { params: { path: string[] } }) {
  try {
    const headers = new Headers()
    const auth = req.headers.get('Authorization')
    const contentType = req.headers.get('Content-Type')
    const accept = req.headers.get('Accept')

    if (auth) headers.set('Authorization', auth)
    if (contentType) headers.set('Content-Type', contentType)
    if (accept) headers.set('Accept', accept)
    headers.set('ngrok-skip-browser-warning', '1')

    const init: RequestInit = {
      method: req.method,
      headers,
      cache: 'no-store',
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = await req.arrayBuffer()
    }

    const response = await fetch(targetUrl(req, params.path), init)
    const responseHeaders = new Headers()
    const responseType = response.headers.get('Content-Type')
    const responseCache = response.headers.get('Cache-Control')

    if (responseType) responseHeaders.set('Content-Type', responseType)
    if (responseCache) {
      responseHeaders.set('Cache-Control', responseCache)
    } else if (responseType && !responseType.includes('application/json')) {
      responseHeaders.set('Cache-Control', 'public, max-age=31536000')
    }

    return new NextResponse(await response.arrayBuffer(), {
      status: response.status,
      headers: responseHeaders,
    })
  } catch (err: any) {
    const errorCode = crypto.randomUUID().slice(0, 10)
    console.error('MessengerPlus proxy error', {
      errorCode,
      method: req.method,
      path: params.path.join('/'),
      target: API,
      error: err?.message || String(err),
    })
    return NextResponse.json(
      { detail: 'Messenger server is unreachable', error_code: errorCode },
      { status: 502 },
    )
  }
}

export async function POST(req: NextRequest, context: { params: { path: string[] } }) {
  return proxy(req, context)
}

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(req, { params })
}
