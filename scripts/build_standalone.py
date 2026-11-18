#!/usr/bin/env python3
"""Inline scripts, styles and saved text data into one shareable HTML file.

Training illustrations and audio retain their public source links and may need
an internet connection; the interface explains this before a training starts.
"""
from pathlib import Path
from html import escape
import re

ROOT = Path(__file__).resolve().parents[1]


def main(root=ROOT):
    root = Path(root)
    html = (root / "index.html").read_text(encoding="utf-8")
    for filename in re.findall(r'<link rel="stylesheet" href="([^"]+)">', html):
        css = (root / filename).read_text(encoding="utf-8")
        html = html.replace(f'<link rel="stylesheet" href="{filename}">', '<style>\n' + css + '\n</style>')
    for filename in re.findall(r'<script src="([^"]+)"></script>', html):
        content = (root / filename).read_text(encoding="utf-8")
        content = re.sub(r"</script", r"<\\/script", content, flags=re.IGNORECASE)
        html = html.replace(f'<script src="{filename}"></script>', f'<script>\n{content}\n</script>')
    license_text = (root / "vendor/ECHARTS-LICENSE.txt").read_text(encoding="utf-8")
    notice = '<template id="third-party-license"><pre>' + escape(license_text) + '</pre></template>'
    body_end = html.rfind('</body>')
    html = html[:body_end] + notice + '\n' + html[body_end:]
    output = root / "samurai-dashboard.html"
    temporary = output.with_suffix(".html.tmp")
    temporary.write_text(html, encoding="utf-8")
    temporary.replace(output)
    print(f"Built {output.name}: {output.stat().st_size:,} bytes; scripts/styles/data inline")


if __name__ == "__main__":
    main()
