import { NextRequest, NextResponse } from 'next/server'

const API = process.env.NEXT_PUBLIC_API_URL || 'https://iodine-napkin-handcraft.ngrok-free.dev'

export async function POST(req: NextRequest, { params }: { params: { path: string[] } }) {
  try {
    const targetUrl = `${API}/${params.path.join('/')}`
    const body = req.body
    const auth = req.headers.get('Authorization') || ''
    
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': req.headers.get('Content-Type') || 'application/json',
        'Authorization': auth,
        'ngrok-skip-browser-warning': '1'
      },
      body: body as any,
      // @ts-ignore
      duplex: 'half'
    })

    let data;
    try {
      data = await response.json()
    } catch {
      return new NextResponse(null, { status: response.status })
    }
    return NextResponse.json(data, { status: response.status })
  } catch (err: any) {
    return NextResponse.json({ detail: err.message }, { status: 500 })
  }
}

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  try {
    const targetUrl = `${API}/${params.path.join('/')}`
    const auth = req.headers.get('Authorization') || ''
    
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Authorization': auth,
        'ngrok-skip-browser-warning': '1'
      }
    })
    
    const contentType = response.headers.get('Content-Type')
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json()
      return NextResponse.json(data, { status: response.status })
    }
    
    // Return raw buffer for images/files
    const buffer = await response.arrayBuffer()
    return new NextResponse(buffer, {
      status: response.status,
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000'
      }
    })
  } catch (err: any) {
    return NextResponse.json({ detail: err.message }, { status: 500 })
  }
}