import uuid
import json
import sqlite3
from datetime import datetime, timezone
from typing import Dict, Any, List
from app.core.exceptions import NotFoundException, ForbiddenException, BadRequestException

class SessionService:
    @staticmethod
    def create_session(db: sqlite3.Connection, user_id: str, assessment_id: str) -> Dict[str, Any]:
        cursor = db.cursor()
        cursor.execute("SELECT id, duration_minutes FROM assessments WHERE id = ?", (assessment_id,))
        assessment = cursor.fetchone()
        if not assessment:
            raise NotFoundException("Assessment not found")

        session_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        initial_remaining = assessment["duration_minutes"] * 60

        cursor.execute("""
            INSERT INTO test_sessions (id, user_id, assessment_id, status, started_at, time_remaining_seconds, created_at, updated_at)
            VALUES (?, ?, ?, 'face_check', ?, ?, ?, ?)
        """, (session_id, user_id, assessment_id, now, initial_remaining, now, now))
        db.commit()

        return {
            "id": session_id,
            "user_id": user_id,
            "assessment_id": assessment_id,
            "status": "face_check",
            "time_remaining_seconds": initial_remaining
        }

    @staticmethod
    def verify_face(db: sqlite3.Connection, session_id: str, user_id: str, descriptor: list) -> Dict[str, Any]:
        cursor = db.cursor()
        cursor.execute("SELECT id, status FROM test_sessions WHERE id = ? AND user_id = ?", (session_id, user_id))
        session = cursor.fetchone()
        if not session:
            raise NotFoundException("Session not found")

        now = datetime.now(timezone.utc).isoformat()
        cursor.execute("""
            UPDATE test_sessions
            SET face_verified = 1, status = 'active', updated_at = ?
            WHERE id = ?
        """, (now, session_id))
        db.commit()
        return {"session_id": session_id, "status": "active", "face_verified": True}

    @staticmethod
    def get_session(db: sqlite3.Connection, session_id: str, current_user: dict) -> Dict[str, Any]:
        cursor = db.cursor()
        cursor.execute("SELECT * FROM test_sessions WHERE id = ?", (session_id,))
        session = cursor.fetchone()
        if not session:
            raise NotFoundException("Session not found")
        
        if current_user["role"] == "candidate" and session["user_id"] != current_user["id"]:
            raise ForbiddenException("Access denied to this session")

        res = dict(session)
        res["answers"] = json.loads(res.get("answers") or "{}")
        return res

    @staticmethod
    def submit_answer(db: sqlite3.Connection, session_id: str, user_id: str, question_id: str, selected_option: str) -> Dict[str, Any]:
        cursor = db.cursor()
        cursor.execute("SELECT id, status, answers FROM test_sessions WHERE id = ? AND user_id = ?", (session_id, user_id))
        session = cursor.fetchone()
        if not session:
            raise NotFoundException("Session not found")
        if session["status"] != "active":
            raise BadRequestException(f"Cannot submit answer when session is {session['status']}")

        answers = json.loads(session["answers"] or "{}")
        answers[question_id] = selected_option
        now = datetime.now(timezone.utc).isoformat()

        cursor.execute("""
            UPDATE test_sessions SET answers = ?, updated_at = ? WHERE id = ?
        """, (json.dumps(answers), now, session_id))
        db.commit()
        return {"question_id": question_id, "selected_option": selected_option}

    @staticmethod
    def process_heartbeat(db: sqlite3.Connection, session_id: str, user_id: str, time_remaining: int) -> Dict[str, Any]:
        cursor = db.cursor()
        cursor.execute("SELECT id, status, assessment_id, active_warning_message, is_paused, warning_count FROM test_sessions WHERE id = ? AND user_id = ?", (session_id, user_id))
        session = cursor.fetchone()
        if not session:
            raise NotFoundException("Session not found")

        now = datetime.now(timezone.utc).isoformat()

        # Handle timeout auto-submission
        if time_remaining <= 0 and session["status"] == "active":
            return SessionService.finalize_submission(db, session_id, user_id, "timed_out")

        warning_to_deliver = session["active_warning_message"]
        if warning_to_deliver:
            cursor.execute("UPDATE test_sessions SET active_warning_message = NULL WHERE id = ?", (session_id,))

        cursor.execute("""
            UPDATE test_sessions SET time_remaining_seconds = ?, updated_at = ? WHERE id = ?
        """, (time_remaining, now, session_id))
        db.commit()

        return {
            "time_remaining_seconds": time_remaining,
            "status": session["status"],
            "is_paused": bool(session["is_paused"]),
            "warning_message": warning_to_deliver,
            "warning_count": session["warning_count"]
        }

    @staticmethod
    def finalize_submission(db: sqlite3.Connection, session_id: str, user_id: str, final_status: str = "submitted") -> Dict[str, Any]:
        cursor = db.cursor()
        cursor.execute("SELECT * FROM test_sessions WHERE id = ? AND user_id = ?", (session_id, user_id))
        session = cursor.fetchone()
        if not session:
            raise NotFoundException("Session not found")

        cursor.execute("SELECT id, correct_option, marks, negative_marks FROM questions WHERE assessment_id = ?", (session["assessment_id"],))
        questions = cursor.fetchall()
        answers = json.loads(session["answers"] or "{}")

        raw_score = 0.0
        total_marks = 0.0

        for q in questions:
            q_id = q["id"]
            total_marks += q["marks"]
            selected = answers.get(q_id)
            if selected:
                if selected.upper() == q["correct_option"].upper():
                    raw_score += q["marks"]
                else:
                    raw_score -= q["negative_marks"]

        raw_score = max(0.0, raw_score)
        percentage = round((raw_score / total_marks * 100), 2) if total_marks > 0 else 0.0

        cursor.execute("SELECT passing_score FROM assessments WHERE id = ?", (session["assessment_id"],))
        assessment = cursor.fetchone()
        passing_score = assessment["passing_score"] if assessment else 60
        passed = 1 if percentage >= passing_score else 0

        now = datetime.now(timezone.utc).isoformat()
        cursor.execute("""
            UPDATE test_sessions
            SET status = ?, submitted_at = ?, score = ?, percentage = ?, passed = ?, updated_at = ?
            WHERE id = ?
        """, (final_status, now, raw_score, percentage, passed, now, session_id))
        db.commit()

        return {
            "session_id": session_id,
            "status": final_status,
            "raw_score": raw_score,
            "total_marks": total_marks,
            "percentage": percentage,
            "passed": bool(passed)
        }

