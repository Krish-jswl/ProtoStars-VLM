#!/bin/bash
set -e
echo "=== Running all tests ==="
cd "$(dirname "$0")/.."

echo "--- Extension tests ---"
cd tests && node --test test_dom.js test_executor.js test_pii.js test_ocr.js test_redaction.js test_integration.js test_secrets.js test_benchmark.js test_network_privacy.js && cd ..

echo "--- Backend tests ---"
cd server && docker run --rm -v $(pwd):/app -e PYTHONPATH=/app privacy-vision-backend pytest tests/test_api.py -v && cd ..

echo "--- Benchmark ---"
node evaluation/run_benchmark.js

echo "=== All done ==="
