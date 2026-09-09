import re

with open('app/chat/page.tsx', 'r', encoding='utf-8') as f:
    c = f.read()

# 1. Imports
if 'emoji-picker-react' not in c:
    c = c.replace("import { gatherClientTelemetry } from '@/lib/telemetry'", "import { gatherClientTelemetry } from '@/lib/telemetry'\nimport EmojiPicker, { Theme } from 'emoji-picker-react'\nimport { uploadImage } from '@/lib/api'")

# 2. States
if 'pickerMode' not in c:
    c = c.replace('const [showStickers, setShowStickers] = useState(false)', "const [pickerMode, setPickerMode] = useState<'none' | 'emoji' | 'sticker'>('none')\n  const fileInputRef = useRef<HTMLInputElement>(null)")
    c = c.replace('showStickers', "(pickerMode === 'sticker')")
    c = c.replace('setShowStickers(false)', "setPickerMode('none')")
    c = c.replace('!showStickers', "pickerMode === 'sticker' ? 'none' : 'sticker'")
    
# 3. File upload handler
if 'handleUpload' not in c:
    c = c.replace('  async function sendMessage(e?: FormEvent, retryText?: string, retryId?: string) {', '''  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files || e.target.files.length === 0) return
    const file = e.target.files[0]
    e.target.value = '' // reset
    try {
      const res = await uploadImage(tokenRef.current!, file)
      sendMessage(undefined, `[image:${res.url}]`)
    } catch (err) {
      alert('Upload failed: ' + err)
    }
  }

  async function sendMessage(e?: FormEvent, retryText?: string, retryId?: string) {''')

# 4. Message Bubble [image:URL]
if 'imageMatch =' not in c:
    bubble_logic = '''                  {(() => {
                    const imageMatch = msg.content.match(/^\\[image:(.+)\\]$/);
                    if (imageMatch) {
                      return (
                        <div className={`relative ${msg.pending ? 'opacity-75' : ''} ${msg.failed ? 'border border-red-500/50 rounded-lg p-1 bg-red-900/20' : ''}`}>
                          <img src={imageMatch[1].startsWith('/') ? 'https://iodine-napkin-handcraft.ngrok-free.dev' + imageMatch[1] : imageMatch[1]} alt=\"image\" className=\"max-w-[200px] sm:max-w-xs rounded-xl shadow-md\" loading=\"lazy\" />
                          <span className={`absolute bottom-2 right-2 text-[10px] whitespace-nowrap inline-flex items-center px-1.5 py-0.5 rounded-full bg-black/40 text-white/90 shadow-sm backdrop-blur-sm`}>
                            {formatTime(msg.timestamp)}
                            {isMe && <Ticks pending={msg.pending} delivered={msg.delivered} read={msg.read} />}
                          </span>
                        </div>
                      )
                    }
                    const stickerMatch = msg.content.match(/^\\[sticker:(.+)\\]$/);'''
    c = c.replace('                  {(() => {\n                    const stickerMatch = msg.content.match(/^\\[sticker:(.+)\\]$/);', bubble_logic)

# 5. Emoji Picker UI
if 'EmojiPicker' in c and '<EmojiPicker' not in c:
    emoji_ui = '''      {/* Picker Overlays */}
      <div className={`bg-gray-900/95 backdrop-blur-xl border-t border-gray-800/50 pt-2 pb-3 px-2 z-20 shrink-0 shadow-[0_-10px_30px_rgba(0,0,0,0.5)] absolute left-0 right-0 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${(pickerMode !== 'none') ? 'bottom-[60px] opacity-100 pointer-events-auto' : 'bottom-[40px] opacity-0 pointer-events-none'}`}>
        {pickerMode === 'emoji' && (
          <div className=\"flex justify-center w-full max-h-[300px] overflow-hidden\">
            <EmojiPicker theme={Theme.DARK} width=\"100%\" onEmojiClick={(e) => setInput(prev => prev + e.emoji)} />
          </div>
        )}
        {pickerMode === 'sticker' && (
          <div className=\"flex gap-2.5 overflow-x-auto pb-2 custom-scrollbar items-center px-1\">
            {STICKERS.map(s => (
              <img 
                key={s} 
                src={`/stickers/${s}`} 
                alt=\"sticker\" 
                className=\"w-[72px] h-[72px] object-contain cursor-pointer hover:scale-110 hover:-translate-y-1 active:scale-95 transition-all shrink-0 drop-shadow-md\" 
                onClick={() => {
                  sendMessage(undefined, `[sticker:${s}]`)
                  setPickerMode('none')
                }} 
              />
            ))}
          </div>
        )}
      </div>'''
    c = re.sub(r'      \{\/\* Sticker Picker Overlay \*\/}.*?<\/div>\n      <\/div>', emoji_ui, c, flags=re.DOTALL)

# 6. File Input Button and Emoji Button
if '<input type=\"file\"' not in c:
    buttons = '''        <form onSubmit={sendMessage} className=\"flex gap-2 items-end px-3 pt-3\">
          <input type=\"file\" ref={fileInputRef} className=\"hidden\" accept=\"image/*\" onChange={handleUpload} />
          <button type=\"button\" onClick={() => fileInputRef.current?.click()} className=\"p-2 rounded-full transition-colors mb-[3px] touch-manipulation focus:outline-none shrink-0 flex items-center justify-center text-gray-400 hover:bg-gray-800 hover:text-gray-200\" title=\"Upload Image\">
            <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" className=\"w-6 h-6\" strokeWidth=\"2\" strokeLinecap=\"round\" strokeLinejoin=\"round\"><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\" ry=\"2\"/><circle cx=\"8.5\" cy=\"8.5\" r=\"1.5\"/><polyline points=\"21 15 16 10 5 21\"/></svg>
          </button>
          <button type=\"button\" onClick={() => setPickerMode(pickerMode === 'emoji' ? 'none' : 'emoji')} className={`p-2 rounded-full transition-colors mb-[3px] touch-manipulation focus:outline-none shrink-0 flex items-center justify-center ${pickerMode === 'emoji' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}`} title=\"Emojis\">
            <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" className=\"w-6 h-6\" strokeWidth=\"2\" strokeLinecap=\"round\" strokeLinejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M8 14s1.5 2 4 2 4-2 4-2\"/><line x1=\"9\" y1=\"9\" x2=\"9.01\" y2=\"9\"/><line x1=\"15\" y1=\"9\" x2=\"15.01\" y2=\"9\"/></svg>
          </button>
          <button type=\"button\" onClick={() => setPickerMode(pickerMode === 'sticker' ? 'none' : 'sticker')} className={`p-2 rounded-full transition-colors mb-[3px] touch-manipulation focus:outline-none shrink-0 flex items-center justify-center ${pickerMode === 'sticker' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}`} title=\"Stickers\">
            <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" className=\"w-6 h-6\" strokeWidth=\"2\" strokeLinecap=\"round\" strokeLinejoin=\"round\"><path d=\"M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z\"/><path d=\"M12 2v20\"/><path d=\"M2 12h20\"/></svg>
          </button>'''
    c = re.sub(r'        <form onSubmit=\{sendMessage\} className=\"flex gap-2 items-end px-3 pt-3\">.*?<\/svg>\n          <\/button>', buttons, c, flags=re.DOTALL)

with open('app/chat/page.tsx', 'w', encoding='utf-8') as f:
    f.write(c)

print('Updated page.tsx with Emojis, File Upload, and Bug Fixes')
