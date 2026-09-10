import re

with open('lib/api.ts', 'r', encoding='utf-8') as f:
    c = f.read()

c = c.replace("\\'info\\'", "'info'")
c = c.replace("\\'warn\\'", "'warn'")
c = c.replace("\\'error\\'", "'error'")
c = c.replace("\\'POST\\'", "'POST'")
c = c.replace("\\'log\\'", "'log'")
c = c.replace("\\'Content-Type\\'", "'Content-Type'")
c = c.replace("\\'application/json\\'", "'application/json'")
c = c.replace("\\`Bearer ${token}\\`", "`Bearer ${token}`")

with open('lib/api.ts', 'w', encoding='utf-8') as f:
    f.write(c)

print('Fixed api.ts syntax')
