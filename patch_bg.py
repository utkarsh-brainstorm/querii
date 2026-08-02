with open('/home/heisenberg/BuilderValley/querii/main.py', 'r') as f:
    content = f.read()

content = content.replace('easy_drag        = False,', 'easy_drag        = False,\n        background_color = "#F7F7F8",')

with open('/home/heisenberg/BuilderValley/querii/main.py', 'w') as f:
    f.write(content)
