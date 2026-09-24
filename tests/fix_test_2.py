with open('/home/krishj/code/privacy-vision-agent/tests/test_redaction.js', 'r') as f:
    content = f.read()

content = content.replace(
    "canvas.getContext('2d').getImageData().data",
    "canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data"
)

with open('/home/krishj/code/privacy-vision-agent/tests/test_redaction.js', 'w') as f:
    f.write(content)
