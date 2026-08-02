from html.parser import HTMLParser

class MyHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []
    
    def handle_starttag(self, tag, attrs):
        if tag not in ['meta', 'link', 'input', 'img', 'br', 'hr']:
            self.tags.append(tag)
            
    def handle_endtag(self, tag):
        if tag not in ['meta', 'link', 'input', 'img', 'br', 'hr']:
            if self.tags and self.tags[-1] == tag:
                self.tags.pop()
            else:
                print(f"Mismatched end tag: {tag}, expected: {self.tags[-1] if self.tags else 'None'}")

parser = MyHTMLParser()
with open('/home/heisenberg/BuilderValley/querii/web/index.html', 'r') as f:
    parser.feed(f.read())
print("Unclosed tags left:", parser.tags)
