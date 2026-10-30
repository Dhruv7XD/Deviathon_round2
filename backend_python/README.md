# Smart Proctoring Browser for Assessment — FastAPI Backend

Production-ready, lightweight, scalable backend built with Python, FastAPI, and Pydantic following clean architecture and separation of concerns.

---

## Architecture Overview

```
backend_python/
├── app/
│   ├── api/
│   │   └── routes/
│   │       ├── health.py        # System health & metadata check
│   │       ├── auth.py          # User registration, login, biometric face enrollment
│   │       ├── assessments.py   # Assessments & MCQ delivery (anti-cheat protected)
│   │       ├── sessions.py      # Test session lifecycle, time tracking, auto-timeout & scoring
│   │       └── proctoring.py    # Real-time telemetry ingestion, AI tool & leakage detection
│   ├── core/
│   │   ├── config.py            # Environment-driven configuration
│   │   ├── security.py          # Password hashing (bcrypt) & JWT token management
│   │   ├── exceptions.py        # Centralized HTTP exception classes
│   │   └── dependencies.py      # Bearer token validation and RBAC guards
│   ├── db/
│   │   └── session.py           # SQLite connection pool (WAL mode) and auto-migrations
│   ├── schemas/
│   │   └── all_schemas.py       # Pydantic v2 validation models and standard response envelopes
│   ├── services/
│   │   ├── auth_service.py      # User authentication business logic
│   │   ├── assessment_service.py# MCQ & assessment management business logic
│   │   ├── session_service.py   # Session state machine, heartbeat, and scoring
│   │   └── proctoring_service.py# AI detection, question leakage, risk scoring & interventions
│   └── main.py                  # FastAPI application entry point, CORS, and exception handlers
├── tests/
│   └── test_api.py              # 14-step automated test suite
├── requirements.txt             # Minimal dependencies
├── .env.example                 # Environment configuration template
└── .env                         # Local runtime configuration
```

---

## Core Capabilities

1. **Authentication & Identity**:
   - JWT-based authentication with expiration controls.
   - Password hashing with salt via `bcrypt`.
   - Role-Based Access Control (`candidate`, `examiner`, `admin`).
   - Facial descriptor vector enrollment for pre-exam identity validation.

2. **Assessments & Anti-Cheat Question Delivery**:
   - Multiple choice questions (MCQs) with customizable mark allocations and negative markings.
   - Candidate views exclude correct options and explanations to prevent client-side network inspection.

3. **Test Session Lifecycle & Time Tracking**:
   - Session states: `pending` -> `face_check` -> `active` -> `paused` -> `submitted` / `timed_out` / `disqualified`.
   - Heartbeat ping mechanism with automatic submission upon timeout (`time_remaining_seconds <= 0`).
   - Real-time examiner alert delivery directly through candidate heartbeats.

4. **Smart Telemetry & AI Detection Engine**:
   - Identifies visits to AI platforms (`ChatGPT`, `Claude`, `Gemini`, `Copilot`, `Perplexity`, etc.).
   - Semantic Question Leakage: Compares search queries and pasted clipboard content against assessment questions.
   - Dynamic Trust Score ($0 - 100$) and Risk Level calculation (`LOW`, `MODERATE`, `HIGH`, `CRITICAL`).
   - Automated disqualification upon reaching maximum warnings.

5. **Live Examiner Dashboard & Interventions**:
   - Real-time candidate monitoring grid sorted by risk and trust index.
   - Remote proctor interventions: `warn` (delivers pop-up alert), `pause`, `resume`, or instant `disqualify`.
   - Executive Proctoring Integrity Audit Report generation with certified report ID.

---

## Quickstart Guide

### 1. Requirements & Setup
```powershell
cd "c:\Users\Computer Care\OneDrive\Desktop\ProctorShield\backend_python"
pip install -r requirements.txt
```

### 2. Run Test Suite
```powershell
$env:PYTHONPATH="."
python tests/test_api.py
```

### 3. Start the Server
```powershell
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

- **Interactive API Documentation (Swagger UI)**: `http://localhost:8000/docs`
- **Alternative Documentation (ReDoc)**: `http://localhost:8000/redoc`
- **OpenAPI JSON Spec**: `http://localhost:8000/openapi.json`
- **API Base URL**: `http://localhost:8000/api`

---

## Pre-seeded Credentials for Testing

| Role | Email | Password |
|---|---|---|
| Candidate | `alice@test.com` | `Test@123` |
| Examiner | `examiner@proctorshield.app` | `Exam@123` |
| Admin | `admin@proctorshield.app` | `Admin@123` |

