import sqlite3
from fastapi import APIRouter, Depends
from app.db.session import get_db
from app.core.dependencies import get_current_user, require_role
from app.schemas.all_schemas import StandardResponse, AssessmentCreate, QuestionCreate
from app.services.assessment_service import AssessmentService

router = APIRouter(prefix="/assessments", tags=["Assessments & Questions"])

@router.get("", response_model=StandardResponse, summary="List published assessments")
def list_assessments(db: sqlite3.Connection = Depends(get_db)):
    assessments = AssessmentService.get_published_assessments(db)
    return StandardResponse(message="Assessments fetched", data={"assessments": assessments})

@router.get("/{assessment_id}", response_model=StandardResponse, summary="Get assessment details")
def get_assessment(assessment_id: str, db: sqlite3.Connection = Depends(get_db)):
    assessment = AssessmentService.get_assessment(db, assessment_id)
    return StandardResponse(message="Assessment fetched", data={"assessment": assessment})

@router.post("", response_model=StandardResponse, summary="Create assessment (Examiner/Admin only)")
def create_assessment(
    data: AssessmentCreate,
    current_user: dict = Depends(require_role("examiner", "admin")),
    db: sqlite3.Connection = Depends(get_db)
):
    created = AssessmentService.create_assessment(db, current_user["id"], data)
    return StandardResponse(message="Assessment created successfully", data=created)

@router.get("/{assessment_id}/questions", response_model=StandardResponse, summary="Get questions for test taking")
def get_questions(
    assessment_id: str,
    current_user: dict = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db)
):
    questions = AssessmentService.get_questions_for_candidate(db, assessment_id)
    return StandardResponse(message="Questions fetched", data={"questions": questions})

@router.post("/{assessment_id}/questions", response_model=StandardResponse, summary="Add question to assessment (Examiner only)")
def add_question(
    assessment_id: str,
    data: QuestionCreate,
    current_user: dict = Depends(require_role("examiner", "admin")),
    db: sqlite3.Connection = Depends(get_db)
):
    created_q = AssessmentService.add_question(db, assessment_id, data)
    return StandardResponse(message="Question added successfully", data=created_q)

