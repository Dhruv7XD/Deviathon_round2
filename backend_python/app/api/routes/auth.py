import sqlite3
from fastapi import APIRouter, Depends
from app.db.session import get_db
from app.core.dependencies import get_current_user
from app.schemas.all_schemas import StandardResponse, UserRegisterRequest, UserLoginRequest, FaceEnrollRequest
from app.services.auth_service import AuthService

router = APIRouter(prefix="/auth", tags=["Authentication"])

@router.post("/register", response_model=StandardResponse, summary="Register candidate/user")
def register(data: UserRegisterRequest, db: sqlite3.Connection = Depends(get_db)):
    result = AuthService.register_user(db, data)
    return StandardResponse(message="User registered successfully", data=result)

@router.post("/login", response_model=StandardResponse, summary="Login with email & password")
def login(data: UserLoginRequest, db: sqlite3.Connection = Depends(get_db)):
    result = AuthService.authenticate_user(db, data)
    return StandardResponse(message="Login successful", data=result)

@router.get("/me", response_model=StandardResponse, summary="Get current authenticated user profile")
def get_me(current_user: dict = Depends(get_current_user)):
    return StandardResponse(message="Profile retrieved", data={"user": current_user})

@router.post("/face/enroll", response_model=StandardResponse, summary="Enroll candidate face descriptor")
def enroll_face(data: FaceEnrollRequest, current_user: dict = Depends(get_current_user), db: sqlite3.Connection = Depends(get_db)):
    result = AuthService.enroll_face(db, current_user["id"], data.face_descriptor)
    return StandardResponse(message="Face descriptor enrolled successfully", data=result)

