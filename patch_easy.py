with open('/home/heisenberg/BuilderValley/querii/main.py', 'r') as f:
    content = f.read()

content = content.replace('min_size         = (800, 600),', 'min_size         = (800, 600),\n        easy_drag        = False,')

with open('/home/heisenberg/BuilderValley/querii/main.py', 'w') as f:
    f.write(content)
