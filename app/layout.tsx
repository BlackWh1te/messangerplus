import type { Metadata, Viewport } from 'next'
import './globals.css'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#111827', // Tailwind gray-900 for mobile status bar
}

export const metadata: Metadata = {
  title: 'MessengerPlus',
  description: 'Private messenger for 2',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-white min-h-[100dvh] overscroll-none selection:bg-indigo-500/30">
        {children}
      </body>
    </html>
  )
}
