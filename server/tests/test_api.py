
import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def valid_payload():
    return {
        "page": {
            "url": "https://example.com",
            "title": "Test",
            "viewport": {"width": 1024, "height": 768}
        },
        "dom": [
            {
                "id": "btn",
                "tag": "button",
                "bbox": {"x": 10, "y": 10, "width": 100, "height": 20},
                "text": "Submit"
            }
        ],
        "image": "data:image/png;base64,mock..."
    }

def test_valid_sanitized_request():
    response = client.post("/v1/agent/plan", json=valid_payload())
    assert response.status_code == 200
    data = response.json()
    assert "actions" in data
    assert data["actions"][0]["type"] == "click"
    assert data["actions"][0]["target"] == "mock_element_1"

def test_malformed_request():
    response = client.post("/v1/agent/plan", json={"bad": "payload"})
    assert response.status_code == 422

def test_missing_required_fields():
    payload = valid_payload()
    del payload["image"]
    response = client.post("/v1/agent/plan", json=payload)
    assert response.status_code == 422

def test_invalid_bounding_box():
    payload = valid_payload()
    payload["dom"][0]["bbox"]["width"] = -10  # Invalid
    response = client.post("/v1/agent/plan", json=payload)
    assert response.status_code == 422
    assert "gt" in response.text or "greater than" in response.text

def test_suspicious_raw_sensitive_content_rejection():
    payload = valid_payload()
    # Insert an unredacted email
    payload["dom"][0]["text"] = "user@secret.com"
    response = client.post("/v1/agent/plan", json=payload)
    assert response.status_code == 422
    assert "Suspicious unredacted email" in response.text

def test_suspicious_credit_card_rejection():
    payload = valid_payload()
    # Insert an unredacted card
    payload["dom"][0]["text"] = "4111 1111 1111 1111"
    response = client.post("/v1/agent/plan", json=payload)
    assert response.status_code == 422
    assert "Suspicious unredacted credit card" in response.text

def test_valid_tokenized_content_allowed():
    payload = valid_payload()
    # Valid token shouldn't trigger rejection
    payload["dom"][0]["text"] = "[EMAIL_1]"
    response = client.post("/v1/agent/plan", json=payload)
    assert response.status_code == 200

def test_oversized_payload(monkeypatch):
    import app.config
    monkeypatch.setattr(app.config.settings, "max_payload_size_mb", 0) # 0 MB max
    
    # Send request with content length
    response = client.post(
        "/v1/agent/plan", 
        json=valid_payload(),
        headers={"content-length": "1000"}
    )
    assert response.status_code == 413
    assert "Payload too large" in response.text

def test_arbitrary_js_action_rejection():
    # To test schema enforcement, we can validate the Action model directly
    from app.schemas import Action, BaseModel
    from pydantic import ValidationError
    
    with pytest.raises(ValidationError) as exc:
        Action(type="eval", target="window", args={"code": "alert(1)"})
    assert "String should match pattern" in str(exc.value)

def test_mock_vlm_returns_safe_action():
    response = client.post("/v1/agent/plan", json=valid_payload())
    assert response.status_code == 200
    actions = response.json()["actions"]
    assert len(actions) == 2
    assert actions[1]["type"] == "type_local"
    assert actions[1]["args"]["secret_ref"] == "PASSWORD_1"
