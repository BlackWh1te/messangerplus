import re

with open('app/chat/page.tsx', 'r', encoding='utf-8') as f:
    c = f.read()

# 1. Update Image SRC
old_img = "imageMatch[1].startsWith('/') ? 'https://iodine-napkin-handcraft.ngrok-free.dev' + imageMatch[1] : imageMatch[1]"
new_img = "imageMatch[1].startsWith('/') ? '/api/proxy' + imageMatch[1] : imageMatch[1]"
c = c.replace(old_img, new_img)

# 2. Extract Picker Overlays precisely
start_idx = c.find('      {/* Picker Overlays */}')
end_idx = c.find('      {/* Input */}')
picker_html = c[start_idx:end_idx]

# 3. Remove Picker Overlays from current location
c = c[:start_idx] + c[end_idx:]

# 4. Modify Picker html to be in flow
new_picker = picker_html.replace(
    "bg-gray-900/95 backdrop-blur-xl border-t border-gray-800/50 pt-2 pb-3 px-2 z-20 shrink-0 shadow-[0_-10px_30px_rgba(0,0,0,0.5)] absolute left-0 right-0 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${(pickerMode !== 'none') ? 'bottom-[60px] opacity-100 pointer-events-auto' : 'bottom-[40px] opacity-0 pointer-events-none'}",
    "bg-gray-900 z-20 shrink-0 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] overflow-hidden flex flex-col ${(pickerMode !== 'none') ? 'h-[300px] border-t border-gray-800/50 pt-2' : 'h-0 border-t-0'}"
)

# 5. Insert it right before the final closing div
parts = c.rsplit('    </div>\n  )\n}', 1)
c = parts[0] + new_picker + '    </div>\n  )\n}'

with open('app/chat/page.tsx', 'w', encoding='utf-8') as f:
    f.write(c)

print('Updated page.tsx')
