import re

with open('app/chat/page.tsx', 'r', encoding='utf-8') as f:
    c = f.read()

# 1. Add outbox queue state
queue_hook = """  const [recentStickers, setRecentStickers] = useState<string[]>([])
  
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
          const msg = await sendMessageHttp(token, item.content, item.id)
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
"""
c = c.replace('  const [recentStickers, setRecentStickers] = useState<string[]>([])', queue_hook)

# 2. Update sendMessage to use Outbox
send_msg_orig = """    if (!retryId) {
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

    try {
      setBanner('')"""

send_msg_new = """    if (!retryId) {
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
      setBanner('')"""
c = c.replace(send_msg_orig, send_msg_new)

# 3. Update sendMessage success to remove from outbox
send_success_orig = """      setMessages(prev => {
        // If WS echo beat us to it, the message is already real.
        const alreadyReal = prev.find(m => m.id === msg.id)
        if (alreadyReal) return prev
        
        // Otherwise replace the optimistic message
        return prev.map(m => m.id === optimisticId ? msg : m)
      })"""

send_success_new = """      // Remove from persistent outbox
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
      })"""
c = c.replace(send_success_orig, send_success_new)

# 4. Load Outbox into initial state so it persists on reload!
merge_orig = """  const mergeMessages = useCallback((fetched: Message[]) => {
    setMessages(prev => {
      let merged = [...prev]
      fetched.forEach(f => {
        const idx = merged.findIndex(m => m.id === f.id || (f.nonce && m.id === f.nonce))
        if (idx !== -1) merged[idx] = { ...merged[idx], ...f, pending: false, failed: false }
        else merged.push(f)
      })
      return merged.sort((a, b) => a.id === b.id ? 0 : (a.id > b.id ? 1 : -1))
    })
  }, [])"""

merge_new = """  const mergeMessages = useCallback((fetched: Message[]) => {
    setMessages(prev => {
      let merged = [...prev]
      
      // Inject outbox into UI if not present
      if (typeof window !== 'undefined') {
        try {
          const outbox = JSON.parse(localStorage.getItem('messenger_outbox') || '[]')
          outbox.forEach((o: any) => {
            if (!merged.find(m => m.id === o.id) && !fetched.find(f => f.nonce === o.id)) {
              merged.push({
                id: o.id,
                sender: usernameRef.current,
                content: o.content,
                timestamp: new Date().toISOString(),
                pending: true,
                failed: true // highlight red since it's an old unsent message
              })
            }
          })
        } catch (e) {}
      }

      fetched.forEach(f => {
        const idx = merged.findIndex(m => m.id === f.id || (f.nonce && m.id === f.nonce))
        if (idx !== -1) merged[idx] = { ...merged[idx], ...f, pending: false, failed: false }
        else merged.push(f)
      })
      return merged.sort((a, b) => {
        // sort logic that handles pending- string IDs vs numbers
        const aNum = typeof a.id === 'number'
        const bNum = typeof b.id === 'number'
        if (aNum && bNum) return (a.id as number) - (b.id as number)
        if (!aNum && !bNum) return (a.id as string).localeCompare(b.id as string)
        return aNum ? -1 : 1 // numbers (real) come before pending
      })
    })
  }, [])"""
c = c.replace(merge_orig, merge_new)

with open('app/chat/page.tsx', 'w', encoding='utf-8') as f:
    f.write(c)

print("Patch applied")
