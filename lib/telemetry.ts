export interface ClientTelemetry {
  device: {
    platform: string
    isMobile: boolean
    browser: string
  }
  network: {
    online: boolean
    type: string
    rtt: number | null
    downlink: number | null
  }
  battery: {
    level: number | null
    isCharging: boolean | null
  }
}

export async function gatherClientTelemetry(): Promise<ClientTelemetry> {
  // 1. Device Info
  let platform = 'Unknown'
  let isMobile = false
  let browser = 'Unknown'

  if (typeof navigator !== 'undefined') {
    const nav = navigator as any
    if (nav.userAgentData) {
      platform = nav.userAgentData.platform || platform
      isMobile = !!nav.userAgentData.mobile
      if (nav.userAgentData.brands?.length > 0) {
        browser = nav.userAgentData.brands[0].brand
      }
    } else {
      const ua = navigator.userAgent
      if (/android/i.test(ua)) platform = 'Android'
      else if (/iphone|ipad|ipod/i.test(ua)) platform = 'iOS'
      else if (/windows/i.test(ua)) platform = 'Windows'
      else if (/mac/i.test(ua)) platform = 'macOS'
      else if (/linux/i.test(ua)) platform = 'Linux'

      isMobile = /mobile|android|iphone|ipad|ipod/i.test(ua)
      
      if (ua.includes('Chrome')) browser = 'Chrome'
      else if (ua.includes('Safari')) browser = 'Safari'
      else if (ua.includes('Firefox')) browser = 'Firefox'
      else if (ua.includes('Edge')) browser = 'Edge'
    }
  }

  // 2. Network Info
  let networkType = 'unknown'
  let rtt: number | null = null
  let downlink: number | null = null

  if (typeof navigator !== 'undefined') {
    const conn = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection
    if (conn) {
      networkType = conn.effectiveType || conn.type || 'unknown'
      if (typeof conn.rtt === 'number') rtt = conn.rtt
      if (typeof conn.downlink === 'number') downlink = conn.downlink
    }
  }

  // 3. Battery Info
  let batteryLevel: number | null = null
  let isCharging: boolean | null = null

  if (typeof navigator !== 'undefined' && (navigator as any).getBattery) {
    try {
      const battery = await (navigator as any).getBattery()
      batteryLevel = battery.level
      isCharging = battery.charging
    } catch {
      // API blocked
    }
  }

  return {
    device: { platform, isMobile, browser },
    network: {
      online: typeof navigator !== 'undefined' ? navigator.onLine : true,
      type: networkType,
      rtt,
      downlink
    },
    battery: {
      level: batteryLevel,
      isCharging
    }
  }
}
