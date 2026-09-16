# Evaluation Report

**Date**: 2026-09-16T13:31:59.095Z
**Environment**: Node.js v22.23.1 (JSDOM simulated browser)
**Runs per page**: 10

> **Note**: Timing measurements are JSDOM-based approximations.
> Real browser performance will differ. Memory measurements unavailable in JSDOM.

## job_application

### PII Detection
| Type | TP | FP | FN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| PERSON | 1 | 1 | 0 | 0.5 | 1 | 0.6667 |
| EMAIL | 1 | 0 | 0 | 1 | 1 | 1 |
| PHONE | 0 | 1 | 1 | 0 | 0 | 0 |
| ADDRESS | 1 | 0 | 0 | 1 | 1 | 1 |
| _aggregate | 3 | 2 | 1 | 0.6 | 0.75 | 0.6667 |

### Redaction
| Covered | Under | Over | Coverage | Avg IoU |
|---|---|---|---|---|
| 3 | 1 | 1 | 0.75 | 0.75 |

### Context Preservation
Score: 7/10 (0.7)

### Timing (ms, 10 runs)
| Phase | Median | P95 | Min | Max |
|---|---|---|---|---|
| dom | 1.4 | 84.3 | 1.21 | 84.3 |
| pii | 0.06 | 1.34 | 0.03 | 1.34 |
| redact | 0.04 | 0.28 | 0.03 | 0.28 |
| gate | 0 | 0 | 0 | 0 |
| total | 1.5 | 85.93 | 1.27 | 85.93 |

---

## email_inbox

### PII Detection
| Type | TP | FP | FN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| PERSON | 0 | 0 | 2 | 0 | 0 | 0 |
| EMAIL | 0 | 0 | 2 | 0 | 0 | 0 |
| PHONE | 0 | 0 | 1 | 0 | 0 | 0 |
| _aggregate | 0 | 0 | 5 | 0 | 0 | 0 |

### Redaction
| Covered | Under | Over | Coverage | Avg IoU |
|---|---|---|---|---|
| 0 | 5 | 0 | 0 | 0 |

### Context Preservation
Score: 10/10 (1)

### Timing (ms, 10 runs)
| Phase | Median | P95 | Min | Max |
|---|---|---|---|---|
| dom | 0.68 | 11.58 | 0.57 | 11.58 |
| pii | 0.01 | 0.03 | 0.01 | 0.03 |
| redact | 0.01 | 0.03 | 0.01 | 0.03 |
| gate | 0 | 0 | 0 | 0 |
| total | 0.7 | 11.65 | 0.6 | 11.65 |

---

## ecommerce_checkout

### PII Detection
| Type | TP | FP | FN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| PERSON | 1 | 0 | 0 | 1 | 1 | 1 |
| ADDRESS | 1 | 0 | 0 | 1 | 1 | 1 |
| PHONE | 0 | 0 | 1 | 0 | 0 | 0 |
| CREDIT_CARD | 1 | 1 | 0 | 0.5 | 1 | 0.6667 |
| _aggregate | 3 | 1 | 1 | 0.75 | 0.75 | 0.75 |

### Redaction
| Covered | Under | Over | Coverage | Avg IoU |
|---|---|---|---|---|
| 3 | 1 | 1 | 0.75 | 0.75 |

### Context Preservation
Score: 5/10 (0.5)

### Timing (ms, 10 runs)
| Phase | Median | P95 | Min | Max |
|---|---|---|---|---|
| dom | 1.5 | 12.11 | 0.9 | 12.11 |
| pii | 0.03 | 0.33 | 0.02 | 0.33 |
| redact | 0.04 | 0.07 | 0.02 | 0.07 |
| gate | 0 | 0 | 0 | 0 |
| total | 1.57 | 12.51 | 0.94 | 12.51 |

---

## travel_booking

### PII Detection
| Type | TP | FP | FN | Precision | Recall | F1 |
|---|---|---|---|---|---|---|
| PERSON | 1 | 1 | 0 | 0.5 | 1 | 0.6667 |
| EMAIL | 1 | 0 | 0 | 1 | 1 | 1 |
| PHONE | 0 | 0 | 1 | 0 | 0 | 0 |
| CREDIT_CARD | 1 | 0 | 0 | 1 | 1 | 1 |
| _aggregate | 3 | 1 | 1 | 0.75 | 0.75 | 0.75 |

### Redaction
| Covered | Under | Over | Coverage | Avg IoU |
|---|---|---|---|---|
| 3 | 1 | 1 | 0.75 | 0.75 |

### Context Preservation
Score: 5/8 (0.625)

### Timing (ms, 10 runs)
| Phase | Median | P95 | Min | Max |
|---|---|---|---|---|
| dom | 1.42 | 9.96 | 0.76 | 9.96 |
| pii | 0.03 | 0.06 | 0.02 | 0.06 |
| redact | 0.04 | 0.07 | 0.03 | 0.07 |
| gate | 0 | 0 | 0 | 0 |
| total | 1.54 | 10.08 | 0.81 | 10.08 |

---

## Limitations
- Timing is JSDOM-based; real browser latency will be higher.
- No screenshot/image benchmarking in JSDOM; visual redaction untested here.
- Memory measurements require real browser (performance.memory is Chrome-only).
- OCR benchmarks require Tesseract.js worker; measured separately.
- Playwright integration pending (see docs).
