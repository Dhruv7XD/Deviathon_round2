from typing import Optional, List, Dict, Any, Union
from pydantic import BaseModel, Field

# --- Common Response Envelope ---
class StandardResponse(BaseModel):
    success: bool = True
    message: str = "Success"
    data: Optional[Any] = None

# --- Auth Schemas ---
class UserRegisterRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=100)
    email: str = Field(..., min_length=5, max_length=100)
    password: str = Field(..., min_length=6)
    role: Optional[str] = "candidate"

class UserLoginRequest(BaseModel):
    email: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: Dict[str, Any]

class FaceEnrollRequest(BaseModel):
    face_descriptor: List[float]

# --- Assessment & Questions Schemas ---
class QuestionCreate(BaseModel):
    question_text: str
    option_a: str
    option_b: str
    option_c: str
    option_d: str
    correct_option: str = Field(..., pattern="^[A-D]$")
    marks: int = 1
    negative_marks: float = 0.0
    order_index: int = 1

class QuestionPublicResponse(BaseModel):
    id: str
    assessment_id: str
    question_text: str
    option_a: str
    option_b: str
    option_c: str
    option_d: str
    marks: int
    negative_marks: float
    order_index: int

class AssessmentCreate(BaseModel):
    title: str = Field(..., min_length=3, max_length=200)
    description: Optional[str] = None
    duration_minutes: int = Field(30, ge=1, le=300)
    max_warnings: int = Field(3, ge=1, le=10)
    passing_score: int = Field(60, ge=0, le=100)

class AssessmentResponse(BaseModel):
    id: str
    title: str
    description: Optional[str]
    duration_minutes: int
    max_warnings: int
    passing_score: int
    is_published: bool

# --- Session Schemas ---
class SessionCreateRequest(BaseModel):
    assessment_id: str

class FaceVerifyRequest(BaseModel):
    face_descriptor: List[float]

class AnswerSubmitRequest(BaseModel):
    question_id: str
    selected_option: str = Field(..., pattern="^[A-D]$")

class HeartbeatRequest(BaseModel):
    time_remaining_seconds: int
    answered_count: int = 0

# --- Proctoring Telemetry Schemas ---
class ProctoringLogEvent(BaseModel):
    session_id: str
    event_type: str
    severity: str = "info"
    payload: Dict[str, Any] = Field(default_factory=dict)

class ProctoringBatchLogRequest(BaseModel):
    events: List[ProctoringLogEvent]

class ProctorInterventionRequest(BaseModel):
    action_type: str = Field(..., pattern="^(warn|pause|resume|disqualify)$")
    message: str = Field(..., min_length=2)
