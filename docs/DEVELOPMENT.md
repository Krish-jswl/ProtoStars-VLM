
# Development Guide

## Running the Backend

By default, the backend runs in mock mode using `MockVLMProvider`.

To opt into the real OpenAI VLM (Phase 8D):
```bash
export VLM_PROVIDER="openai"
export OPENAI_API_KEY="sk-..."
export REAL_VLM_ENABLED="true" # For smoke tests
```

## Running Tests

### Backend Tests
```bash
cd server
docker run --rm -v $(pwd):/app -e PYTHONPATH=/app privacy-vision-backend pytest tests/ -v
```

To run the opt-in real VLM smoke test:
```bash
docker run --rm -v $(pwd):/app -e PYTHONPATH=/app -e REAL_VLM_ENABLED=true -e OPENAI_API_KEY=$OPENAI_API_KEY privacy-vision-backend pytest tests/test_openai_vlm.py -v
```
