import sqlite3
from fastapi import APIRouter, Depends
from app.db.session import get_db
from app.core.dependencies import get_current_user, require_role
from app.schemas.all_schemas import (
    StandardResponse,
    ProctoringLogEvent,
    ProctoringBatchLogRequest,
    ProctorInterventionRequest
)
from app.services.proctoring_service import ProctoringService

router = APIRouter(prefix="/proctoring", tags=["Proctoring & Telemetry"])

@router.post("/log", response_model=StandardResponse, summary="Ingest single proctoring telemetry event")
def log_telemetry(
    data: ProctoringLogEvent,
    current_user: dict = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db)
):
    result = ProctoringService.log_event(db, current_user["id"], data.model_dump())
    return StandardResponse(message="Telemetry processed", data=result)

@router.post("/log/batch", response_model=StandardResponse, summary="Ingest buffered proctoring events batch")
def log_telemetry_batch(
    data: ProctoringBatchLogRequest,
    current_user: dict = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db)
):
    results = [
        ProctoringService.log_event(db, current_user["id"], event.model_dump())
        for event in data.events
    ]
    return StandardResponse(message=f"{len(results)} events processed", data={"results": results})

@router.get("/live-dashboard", response_model=StandardResponse, summary="Real-time candidate grid (Examiner only)")
def live_dashboard(
    current_user: dict = Depends(require_role("examiner", "admin")),
    db: sqlite3.Connection = Depends(get_db)
):
    candidates = ProctoringService.get_live_dashboard(db)
    return StandardResponse(message="Live dashboard loaded", data={"candidates": candidates})

@router.post("/intervene/{session_id}", response_model=StandardResponse, summary="Send proctor warning or pause/disqualify test")
def intervene(
    session_id: str,
    data: ProctorInterventionRequest,
    current_user: dict = Depends(require_role("examiner", "admin")),
    db: sqlite3.Connection = Depends(get_db)
):
    result = ProctoringService.intervene(db, current_user["id"], session_id, data.action_type, data.message)
    return StandardResponse(message="Intervention executed", data=result)

@router.get("/audit-report/{session_id}", response_model=StandardResponse, summary="Get official proctoring integrity audit report")
def audit_report(
    session_id: str,
    current_user: dict = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db)
):
    report = ProctoringService.get_audit_report(db, session_id)
    return StandardResponse(message="Audit report generated", data={"report": report})

