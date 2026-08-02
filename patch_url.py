with open('/home/heisenberg/BuilderValley/querii/main.py', 'r') as f:
    content = f.read()

content = content.replace('url              = "web/index.html",', 'url              = f"file://{html_path}",')

with open('/home/heisenberg/BuilderValley/querii/main.py', 'w') as f:
    f.write(content)
