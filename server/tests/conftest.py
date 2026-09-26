"""Pytest setup for the backend package.

The repository can be tested from its root as well as from ``server/``. Keep
unit tests deterministic/offline while making ``app`` importable in both cases.
"""

import os
import sys
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[1]
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

# The repository includes a local provider configuration for manual runs. API
# contract tests must not accidentally call a real VLM.
os.environ["VLM_PROVIDER"] = "mock"
