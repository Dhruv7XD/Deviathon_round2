import uuid
import json
from datetime import datetime, timezone
import sqlite3
from app.core.security import hash_password, verify_password, create_access_token
from app.core.exceptions import BadRequestException, UnauthorizedException, NotFoundException
from app.schemas.all_schemas import UserRegisterRequest, UserLoginRequest

class AuthService:
    @staticmethod
    def register_user(db: sqlite3.Connection, data: UserRegisterRequest) -> dict:
        cursor = db.cursor()
        cursor.execute("SELECT id FROM users WHERE email = ?", (data.email,))
        if cursor.fetchone():
            raise BadRequestException("User with this email already exists")

        user_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        pwd_hash = hash_password(data.password)

        cursor.execute("""
            INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (user_id, data.name, data.email, pwd_hash, data.role or "candidate", now, now))
        db.commit()

        token = create_access_token({"sub": user_id, "email": data.email, "role": data.role or "candidate", "name": data.name})
        return {
            "access_token": token,
            "token_type": "bearer",
            "user": {"id": user_id, "name": data.name, "email": data.email, "role": data.role or "candidate"}
        }

    @staticmethod
    def authenticate_user(db: sqlite3.Connection, data: UserLoginRequest) -> dict:
        cursor = db.cursor()
        cursor.execute("SELECT id, name, email, password_hash, role FROM users WHERE email = ?", (data.email,))
        user = cursor.fetchone()
        if not user or not verify_password(data.password, user["password_hash"]):
            raise UnauthorizedException("Invalid email or password")

        token = create_access_token({"sub": user["id"], "email": user["email"], "role": user["role"], "name": user["name"]})
        return {
            "access_token": token,
            "token_type": "bearer",
            "user": {"id": user["id"], "name": user["name"], "email": user["email"], "role": user["role"]}
        }

    @staticmethod
    def enroll_face(db: sqlite3.Connection, user_id: str, descriptor: list) -> dict:
        cursor = db.cursor()
        now = datetime.now(timezone.utc).isoformat()
        cursor.execute("""
            UPDATE users SET face_enrolled = 1, face_descriptor = ?, updated_at = ?
            WHERE id = ?
        """, (json.dumps(descriptor), now, user_id))
        db.commit()
        return {"face_enrolled": True}

