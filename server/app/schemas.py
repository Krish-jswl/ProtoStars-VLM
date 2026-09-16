
import re
from pydantic import BaseModel, Field, field_validator
from typing import List, Optional, Dict, Any

class Bbox(BaseModel):
    x: float
    y: float
    width: float = Field(..., gt=0, description="Width must be positive")
    height: float = Field(..., gt=0, description="Height must be positive")

class DOMNode(BaseModel):
    id: str = ""
    tag: str = ""
    role: str = ""
    text: str = ""
    inputType: str = ""
    bbox: Bbox
    visible: bool = True
    enabled: bool = True

    @field_validator('text')
    @classmethod
    def prevent_sensitive_leakage(cls, v: str) -> str:
        # Defense in depth: Check for unredacted emails
        # If it looks like an email but isn't a token [EMAIL_X]
        if re.search(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b', v):
            if not (v.startswith('[') and v.endswith(']')):
                raise ValueError("Suspicious unredacted email detected by server")
        # Check for unredacted credit cards (simplified)
        if re.search(r'\b(?:\d[ -]*?){13,16}\b', v):
            raise ValueError("Suspicious unredacted credit card detected by server")
        return v

class Viewport(BaseModel):
    width: int = Field(..., gt=0)
    height: int = Field(..., gt=0)

class PageContext(BaseModel):
    url: str
    title: str = ""
    viewport: Viewport

class SanitizedContext(BaseModel):
    page: PageContext
    dom: List[DOMNode] = Field(..., max_length=5000, description="Max 5000 DOM nodes")
    image: str = Field(..., max_length=10000000, description="Base64 image, max ~10MB")
    
class Action(BaseModel):
    type: str = Field(..., pattern="^(click|scroll|focus|select|wait|type_local)$")
    target: str = ""
    args: Dict[str, Any] = Field(default_factory=dict)

class PlanResponse(BaseModel):
    actions: List[Action]
