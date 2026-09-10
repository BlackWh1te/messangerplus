import re

with open('app/chat/page.tsx', 'r', encoding='utf-8') as f:
    c = f.read()

# import sendLog
c = c.replace("import { getMessages, getStatus, getWsUrl, sendMessageHttp } from '@/lib/api'", "import { getMessages, getStatus, getWsUrl, sendMessageHttp, sendLog } from '@/lib/api'")

# log connection drops
ws_drop = """        if (reconnectRef.current) clearTimeout(reconnectRef.current)
        reconnectRef.current = setTimeout(connect, Math.min(1000 * Math.pow(1.5, backoffRef.current), 15000))
        backoffRef.current++
      }
    }"""
ws_drop_new = """        sendLog(token, 'warn', 'WS_DISCONNECTED', { backoff: backoffRef.current })
        if (reconnectRef.current) clearTimeout(reconnectRef.current)
        reconnectRef.current = setTimeout(connect, Math.min(1000 * Math.pow(1.5, backoffRef.current), 15000))
        backoffRef.current++
      }
    }"""
c = c.replace(ws_drop, ws_drop_new)

# log outbox retry
outbox_retry = """          const msg = await sendMessageHttp(token, item.content, item.id)"""
outbox_retry_new = """          sendLog(token, 'info', 'OUTBOX_RETRY_START', { id: item.id, length: item.content.length })
          const msg = await sendMessageHttp(token, item.content, item.id)
          sendLog(token, 'info', 'OUTBOX_RETRY_SUCCESS', { id: item.id })"""
c = c.replace(outbox_retry, outbox_retry_new)

# log http send error
http_err = """      // Mark as failed if HTTP request fails (network down)
      setMessages(prev => prev.map(m => m.id === optimisticId ? { ...m, failed: true, pending: false } : m))
      setBanner(err instanceof Error ? err.message : 'Message failed to send')"""
http_err_new = """      sendLog(token, 'error', 'SEND_HTTP_FAILED', { id: optimisticId, error: err instanceof Error ? err.message : String(err) })
      // Mark as failed if HTTP request fails (network down)
      setMessages(prev => prev.map(m => m.id === optimisticId ? { ...m, failed: true, pending: false } : m))
      setBanner(err instanceof Error ? err.message : 'Message failed to send')"""
c = c.replace(http_err, http_err_new)

with open('app/chat/page.tsx', 'w', encoding='utf-8') as f:
    f.write(c)

print('Patched page.tsx logging')
