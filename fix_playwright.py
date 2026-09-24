import re

with open('/home/krishj/code/privacy-vision-agent/tests/e2e/test_extension.spec.js', 'r') as f:
    content = f.read()

content = content.replace("await page.route('http://localhost:8000/v1/agent/plan'", "await context.route('http://localhost:8000/v1/agent/plan'")

with open('/home/krishj/code/privacy-vision-agent/tests/e2e/test_extension.spec.js', 'w') as f:
    f.write(content)
