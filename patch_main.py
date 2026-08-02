import sys

with open('/home/heisenberg/BuilderValley/querii/main.py', 'r') as f:
    content = f.read()

content = content.replace('url              = f"file://{html_path}",', 'url              = "web/index.html",')

with open('/home/heisenberg/BuilderValley/querii/main.py', 'w') as f:
    f.write(content)
