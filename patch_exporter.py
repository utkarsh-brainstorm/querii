import re
from pathlib import Path

# Read the default CSS
css_path = Path("/home/heisenberg/BuilderValley/querii/defult_style.css")
css_content = css_path.read_text(encoding="utf-8")

# Modify CSS for f-string and dynamic variables
css_content = css_content.replace("{", "{{").replace("}", "}}")
css_content = css_content.replace("size: A4 portrait;", "size: {css_page_size};")
# Add watermark rule inside the CSS string
watermark_rule = """
    /* ── Watermark (CSS-only, no JS needed) ── */
    body::before {{
      content: "{wm_text}  {wm_text}  {wm_text}  {wm_text}  {wm_text}  {wm_text}  {wm_text}  {wm_text}  {wm_text}  {wm_text}";
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-28deg);
      font-size: 38pt;
      font-weight: 900;
      color: rgba(15,23,42,0.04);
      white-space: nowrap;
      pointer-events: none;
      z-index: -1;
      letter-spacing: 0.3em;
      word-spacing: 0.5em;
    }}
"""
css_content += watermark_rule

exporter_path = Path("/home/heisenberg/BuilderValley/querii/core/exporter.py")
exporter_text = exporter_path.read_text(encoding="utf-8")

# Find the boundaries of the inline CSS
start_idx = exporter_text.find("  <style>\n") + len("  <style>\n")
end_idx = exporter_text.find("    /* ── Page break helpers ── */")
if start_idx != -1 and end_idx != -1:
    new_text = exporter_text[:start_idx] + css_content + exporter_text[end_idx:]
    exporter_path.write_text(new_text, encoding="utf-8")
    print("Successfully patched exporter.py CSS!")
else:
    print("Could not find CSS boundaries in exporter.py")

# Now update app.js default custom CSS
app_path = Path("/home/heisenberg/BuilderValley/querii/web/app.js")
app_text = app_path.read_text(encoding="utf-8")

# Wait, the user said "Take this as base style for the application."
# Does that mean it should be the default custom CSS shown in the textarea?
# Yes, or it replaces the base CSS in exporter.py. 
# We already replaced the base CSS in exporter.py.

