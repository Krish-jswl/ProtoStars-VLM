import re

with open('/home/krishj/code/privacy-vision-agent/tests/test_redaction.js', 'r') as f:
    content = f.read()

# Replace new MockCanvas with createMockCanvas
content = content.replace("new MockCanvas(", "createMockCanvas(")

# Inject createMockCanvas at the end of the file
content += """
function createMockCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    return c;
}
"""

with open('/home/krishj/code/privacy-vision-agent/tests/test_redaction.js', 'w') as f:
    f.write(content)
