with open('app/chat/page.tsx', 'r', encoding='utf-8') as f:
    c = f.read()

import re

# find mergeMessages logic block
match = re.search(r'// Merge new messages from HTTP poll.*?}, \[\]\)', c, re.DOTALL)
if match:
    old = match.group(0)
    new = """// Merge new messages from HTTP poll
  const mergeMessages = useCallback((fetched: Message[]) => {
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
  }, [])"""
    c = c.replace(old, new)
    with open('app/chat/page.tsx', 'w', encoding='utf-8') as f:
        f.write(c)
    print('Fixed')
else:
    print('Not found')
