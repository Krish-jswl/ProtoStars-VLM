# Evaluation Report

**Date**: 2026-09-16T13:37:52.240Z
**Environment**: Node.js v22.23.1 (JSDOM simulated browser)
**Runs per page**: 10

> **Note**: Timing measurements are JSDOM-based approximations.
> Real browser performance will differ. Memory measurements unavailable in JSDOM.

## job_application

### PII Detection
| Type | TP | FP | FN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| PERSON | 1 | 0 | 0 | 1 | 1 | 1 |
| EMAIL | 1 | 0 | 0 | 1 | 1 | 1 |
| PHONE | 1 | 0 | 0 | 1 | 1 | 1 |
| ADDRESS | 1 | 0 | 0 | 1 | 1 | 1 |
| _aggregate | 4 | 0 | 0 | 1 | 1 | 1 |

### Redaction
| Covered | Under | Over | Coverage | Avg IoU |
|---|---|---|---|---|
| 4 | 0 | 0 | 1 | 1 |

### Context Preservation
Score: 10/10 (1)

### Timing (ms, 10 runs)
| Phase | Median | P95 | Min | Max |
|---|---|---|---|---|
| dom | 2.45 | 101.64 | 2.17 | 101.64 |
| pii | 0.05 | 1.05 | 0.04 | 1.05 |
| redact | 0.06 | 0.29 | 0.05 | 0.29 |
| gate | 0 | 0 | 0 | 0 |
| total | 2.56 | 102.99 | 2.26 | 102.99 |

---

## email_inbox

### PII Detection
| Type | TP | FP | FN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| PERSON | 0 | 0 | 2 | 0 | 0 | 0 |
| EMAIL | 2 | 0 | 0 | 1 | 1 | 1 |
| PHONE | 1 | 0 | 0 | 1 | 1 | 1 |
| _aggregate | 3 | 0 | 2 | 1 | 0.6 | 0.75 |

### Redaction
| Covered | Under | Over | Coverage | Avg IoU |
|---|---|---|---|---|
| 5 | 0 | 0 | 1 | 1 |

### Context Preservation
Score: 10/10 (1)

### Timing (ms, 10 runs)
| Phase | Median | P95 | Min | Max |
|---|---|---|---|---|
| dom | 2.45 | 44.88 | 1.93 | 44.88 |
| pii | 0.04 | 0.34 | 0.03 | 0.34 |
| redact | 0.05 | 0.11 | 0.03 | 0.11 |
| gate | 0 | 0 | 0 | 0 |
| total | 2.53 | 45.34 | 2 | 45.34 |

---

## ecommerce_checkout

### PII Detection
| Type | TP | FP | FN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| PERSON | 1 | 0 | 0 | 1 | 1 | 1 |
| ADDRESS | 1 | 0 | 0 | 1 | 1 | 1 |
| PHONE | 1 | 0 | 0 | 1 | 1 | 1 |
| CREDIT_CARD | 1 | 1 | 0 | 0.5 | 1 | 0.6667 |
| _aggregate | 4 | 1 | 0 | 0.8 | 1 | 0.8889 |

### Redaction
| Covered | Under | Over | Coverage | Avg IoU |
|---|---|---|---|---|
| 4 | 0 | 1 | 1 | 1 |

### Context Preservation
Score: 10/10 (1)

### Timing (ms, 10 runs)
| Phase | Median | P95 | Min | Max |
|---|---|---|---|---|
| dom | 3.32 | 27.58 | 2.71 | 27.58 |
| pii | 0.04 | 0.24 | 0.04 | 0.24 |
| redact | 0.07 | 0.09 | 0.06 | 0.09 |
| gate | 0 | 0 | 0 | 0 |
| total | 3.45 | 27.94 | 2.81 | 27.94 |

---

## travel_booking

### PII Detection
| Type | TP | FP | FN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| PERSON | 1 | 0 | 0 | 1 | 1 | 1 |
| EMAIL | 1 | 0 | 0 | 1 | 1 | 1 |
| PHONE | 1 | 0 | 0 | 1 | 1 | 1 |
| CREDIT_CARD | 1 | 0 | 0 | 1 | 1 | 1 |
| _aggregate | 4 | 0 | 0 | 1 | 1 | 1 |

### Redaction
| Covered | Under | Over | Coverage | Avg IoU |
|---|---|---|---|---|
| 4 | 0 | 0 | 1 | 1 |

### Context Preservation
Score: 8/8 (1)

### Timing (ms, 10 runs)
| Phase | Median | P95 | Min | Max |
|---|---|---|---|---|
| dom | 2.35 | 19.18 | 1.44 | 19.18 |
| pii | 0.05 | 0.06 | 0.03 | 0.06 |
| redact | 0.08 | 0.12 | 0.05 | 0.12 |
| gate | 0 | 0 | 0 | 0 |
| total | 2.47 | 19.36 | 1.54 | 19.36 |

---

## Limitations
- Timing is JSDOM-based; real browser latency will be higher.
- No screenshot/image benchmarking in JSDOM; visual redaction untested here.
- Memory measurements require real browser (performance.memory is Chrome-only).
- OCR benchmarks require Tesseract.js worker; measured separately.
- Playwright integration pending (see docs).
