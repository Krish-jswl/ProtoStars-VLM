#!/bin/bash
echo "=== Phase 8C E2E Test Runner ==="

# The manifest loads the checked-in content bundle, not the ES module source.
# Rebuild it before every browser run so runtime tests exercise current code.
if ! command -v npx &> /dev/null; then
    echo "ERROR: npx is not installed."
    exit 1
fi

npx esbuild extension/content/content_main.js --bundle --format=iife --platform=browser --outfile=extension/content/content_bundle.js

if ! npx playwright --version &> /dev/null; then
    echo "Playwright not installed, installing..."
    npm install -D @playwright/test
    npx playwright install chromium
fi

if command -v xvfb-run &> /dev/null; then
    echo "Found xvfb-run. Running tests with Xvfb..."
    xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24" npx playwright test
else
    echo "WARNING: xvfb-run is not installed."
    echo "Chromium extension testing requires a display server (headed mode)."
    echo ""
    echo "To run these tests in this container, you MUST install xvfb:"
    echo "  sudo apt-get update && sudo apt-get install -y xvfb"
    echo "  xvfb-run npx playwright test"
    echo ""
    echo "If you are on a machine with a GUI/display server (X11/Wayland), simply run:"
    echo "  npx playwright test"
    echo ""
    echo "Exiting without running tests to avoid headless extension crash."
    exit 0
fi
