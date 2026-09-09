import type { Metadata, Viewport } from 'next'
import './globals.css'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#23211f',
}

export const metadata: Metadata = {
  title: 'MessengerPlus',
  description: 'Private messenger for 2',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#171716] text-white min-h-[100dvh] overscroll-none selection:bg-teal-500/30">
        {children}
      </body>
    </html>
  )
}
