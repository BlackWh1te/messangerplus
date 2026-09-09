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
      body
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

    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch (err: any) {
    return NextResponse.json({ detail: err.message }, { status: 500 })
  }
}
