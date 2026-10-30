import uuid
import sqlite3
from datetime import datetime, timezone
from typing import List, Dict, Any
from app.core.exceptions import NotFoundException
from app.schemas.all_schemas import AssessmentCreate, QuestionCreate

class AssessmentService:
    @staticmethod
    def get_published_assessments(db: sqlite3.Connection) -> List[Dict[str, Any]]:
        cursor = db.cursor()
        cursor.execute("SELECT id, title, description, duration_minutes, max_warnings, passing_score, is_published FROM assessments WHERE is_published = 1")
        rows = cursor.fetchall()
        return [dict(row) for row in rows]

    @staticmethod
    def get_assessment(db: sqlite3.Connection, assessment_id: str) -> Dict[str, Any]:
        cursor = db.cursor()
        cursor.execute("SELECT * FROM assessments WHERE id = ?", (assessment_id,))
        row = cursor.fetchone()
        if not row:
            raise NotFoundException("Assessment not found")
        return dict(row)

    @staticmethod
    def create_assessment(db: sqlite3.Connection, creator_id: str, data: AssessmentCreate) -> Dict[str, Any]:
        cursor = db.cursor()
        assessment_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        cursor.execute("""
            INSERT INTO assessments (id, title, description, created_by, duration_minutes, max_warnings, passing_score, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (assessment_id, data.title, data.description, creator_id, data.duration_minutes, data.max_warnings, data.passing_score, now, now))
        db.commit()
        return {"id": assessment_id, **data.model_dump()}

    @staticmethod
    def get_questions_for_candidate(db: sqlite3.Connection, assessment_id: str) -> List[Dict[str, Any]]:
        cursor = db.cursor()
        cursor.execute("""
            SELECT id, assessment_id, question_text, option_a, option_b, option_c, option_d, marks, negative_marks, order_index
            FROM questions
            WHERE assessment_id = ?
            ORDER BY order_index ASC
        """, (assessment_id,))
        rows = cursor.fetchall()
        return [dict(row) for row in rows]

    @staticmethod
    def add_question(db: sqlite3.Connection, assessment_id: str, data: QuestionCreate) -> Dict[str, Any]:
        cursor = db.cursor()
        q_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        cursor.execute("""
            INSERT INTO questions (id, assessment_id, question_text, option_a, option_b, option_c, option_d, correct_option, marks, negative_marks, order_index, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (q_id, assessment_id, data.question_text, data.option_a, data.option_b, data.option_c, data.option_d, data.correct_option, data.marks, data.negative_marks, data.order_index, now))
        db.commit()
        return {"id": q_id, **data.model_dump()}

