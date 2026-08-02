with open('/home/heisenberg/BuilderValley/querii/main.py', 'r') as f:
    content = f.read()

content = content.replace('width            = 1440', 'width            = 1024')
content = content.replace('height           = 920', 'height           = 768')
content = content.replace('min_size         = (1100, 720)', 'min_size         = (800, 600)')

with open('/home/heisenberg/BuilderValley/querii/main.py', 'w') as f:
    f.write(content)
