with open('/home/heisenberg/BuilderValley/querii/main.py', 'r') as f:
    content = f.read()

content = content.replace('        easy_drag        = False,\n', '')
content = content.replace('        background_color = "#0F0F10",\n', '')

with open('/home/heisenberg/BuilderValley/querii/main.py', 'w') as f:
    f.write(content)
