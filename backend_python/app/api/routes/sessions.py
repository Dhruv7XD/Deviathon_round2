import sqlite3
from fastapi import APIRouter, Depends
from app.db.session import get_db
from app.core.dependencies import get_current_user
from app.schemas.all_schemas import (
    StandardResponse,
    SessionCreateRequest,
    FaceVerifyRequest,
    AnswerSubmitRequest,
    HeartbeatRequest
)
from app.services.session_service import SessionService

router = APIRouter(prefix="/sessions", tags=["Test Sessions"])

@router.post("", response_model=StandardResponse, summary="Start new test session")
def create_session(
    data: SessionCreateRequest,
    current_user: dict = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db)
):
    session = SessionService.create_session(db, current_user["id"], data.assessment_id)
    return StandardResponse(message="Session initialized", data={"session": session})

@router.post("/{session_id}/face-verify", response_model=StandardResponse, summary="Verify candidate face before test begins")
def verify_face(
    session_id: str,
    data: FaceVerifyRequest,
    current_user: dict = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db)
):
    result = SessionService.verify_face(db, session_id, current_user["id"], data.face_descriptor)
    return StandardResponse(message="Face verification successful", data=result)

@router.get("/{session_id}", response_model=StandardResponse, summary="Get session state")
def get_session(
    session_id: str,
    current_user: dict = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db)
):
    session = SessionService.get_session(db, session_id, current_user)
    return StandardResponse(message="Session details fetched", data={"session": session})

@router.post("/{session_id}/answer", response_model=StandardResponse, summary="Submit/update answer for a question")
def submit_answer(
    session_id: str,
    data: AnswerSubmitRequest,
    current_user: dict = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db)
):
    result = SessionService.submit_answer(db, session_id, current_user["id"], data.question_id, data.selected_option)
    return StandardResponse(message="Answer recorded", data=result)

@router.post("/{session_id}/heartbeat", response_model=StandardResponse, summary="Keep-alive heartbeat and auto-timeout check")
def heartbeat(
    session_id: str,
    data: HeartbeatRequest,
    current_user: dict = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db)
):
    result = SessionService.process_heartbeat(db, session_id, current_user["id"], data.time_remaining_seconds)
    return StandardResponse(message="Heartbeat processed", data=result)

@router.post("/{session_id}/submit", response_model=StandardResponse, summary="Finalize and submit assessment")
def submit_test(
    session_id: str,
    current_user: dict = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db)
):
    result = SessionService.finalize_submission(db, session_id, current_user["id"], "submitted")
    return StandardResponse(message="Assessment submitted successfully", data=result)

