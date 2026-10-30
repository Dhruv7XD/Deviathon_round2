import uuid
import json
import sqlite3
import re
from datetime import datetime, timezone
from typing import Dict, Any, List
from app.core.exceptions import NotFoundException

AI_TOOL_DOMAINS = [
    "chat.openai.com", "chatgpt.com", "claude.ai", "anthropic.com",
    "gemini.google.com", "bard.google.com", "copilot.microsoft.com",
    "perplexity.ai", "you.com", "phind.com", "blackbox.ai"
]

class ProctoringService:
    @staticmethod
    def _check_ai_tool(url: str) -> str:
        if not url:
            return ""
        u = url.lower()
        for domain in AI_TOOL_DOMAINS:
            if domain in u:
                return domain
        return ""

    @staticmethod
    def _check_leakage(db: sqlite3.Connection, assessment_id: str, query_text: str) -> Dict[str, Any]:
        if not query_text or len(query_text.strip()) < 5:
            return {"leakage": False}

        cursor = db.cursor()
        cursor.execute("SELECT id, question_text FROM questions WHERE assessment_id = ?", (assessment_id,))
        questions = cursor.fetchall()

        clean_query = set(re.findall(r'\w+', query_text.lower()))
        for q in questions:
            q_words = set(re.findall(r'\w+', q["question_text"].lower()))
            overlap = clean_query.intersection(q_words)
            if len(overlap) >= 3 or (len(q_words) > 0 and len(overlap) / len(q_words) >= 0.4):
                return {
                    "leakage": True,
                    "matched_question_id": q["id"],
                    "matched_snippet": q["question_text"][:60]
                }
        return {"leakage": False}

    @staticmethod
    def log_event(db: sqlite3.Connection, user_id: str, event_data: dict) -> Dict[str, Any]:
        session_id = event_data["session_id"]
        event_type = event_data["event_type"]
        severity = event_data.get("severity", "info")
        payload = event_data.get("payload", {})
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except Exception:
                payload = {}

        cursor = db.cursor()
        cursor.execute("SELECT id, assessment_id, warning_count, status, trust_score FROM test_sessions WHERE id = ?", (session_id,))
        session = cursor.fetchone()
        if not session:
            raise NotFoundException("Test session not found")

        cursor.execute("SELECT max_warnings FROM assessments WHERE id = ?", (session["assessment_id"],))
        assessment = cursor.fetchone()
        max_warnings = assessment["max_warnings"] if assessment else 3

        flagged = False
        detected_tool = None
        leakage_info = None

        # 1. AI Tool Detection
        url = payload.get("toUrl") or payload.get("url") or ""
        matched_ai = ProctoringService._check_ai_tool(url)
        if matched_ai or event_type == "ai_tool_access":
            event_type = "ai_tool_access"
            severity = "critical"
            flagged = True
            detected_tool = matched_ai or payload.get("tool") or "AI Service"
            payload["detected_ai"] = detected_tool

        # 2. Semantic Question Leakage Detection
        search_query = payload.get("searchQuery") or payload.get("pastedText") or payload.get("query") or ""
        if search_query:
            leakage = ProctoringService._check_leakage(db, session["assessment_id"], search_query)
            if leakage.get("leakage"):
                event_type = "question_leakage"
                severity = "critical"
                flagged = True
                leakage_info = leakage
                payload["question_leakage"] = leakage

        # 3. Macro / Keystroke Burst
        char_count = payload.get("charCount", 0)
        duration_ms = payload.get("durationMs", 1000)
        if char_count > 25 and duration_ms < 100:
            event_type = "keystroke_anomaly"
            severity = "warning"
            payload["macro_detected"] = True

        # Warning & Trust Deduction calculation
        warning_count = session["warning_count"]
        trust_score = session["trust_score"]

        if flagged or severity == "critical":
            warning_count += 1
            trust_score = max(0.0, trust_score - 25.0)
        elif severity == "warning":
            trust_score = max(0.0, trust_score - 10.0)

        risk_level = "LOW"
        if trust_score < 40:
            risk_level = "CRITICAL"
        elif trust_score < 65:
            risk_level = "HIGH"
        elif trust_score < 85:
            risk_level = "MODERATE"

        new_status = session["status"]
        disqualify_reason = None
        if warning_count >= max_warnings:
            new_status = "disqualified"
            disqualify_reason = f"Exceeded max warnings ({max_warnings}) due to {event_type}"

        now = datetime.now(timezone.utc).isoformat()
        cursor.execute("""
            UPDATE test_sessions
            SET warning_count = ?, trust_score = ?, risk_level = ?, status = ?,
                disqualification_reason = COALESCE(?, disqualification_reason), updated_at = ?
            WHERE id = ?
        """, (warning_count, trust_score, risk_level, new_status, disqualify_reason, now, session_id))

        log_id = str(uuid.uuid4())
        cursor.execute("""
            INSERT INTO proctoring_logs (id, session_id, user_id, event_type, severity, payload, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (log_id, session_id, user_id, event_type, severity, json.dumps(payload), now))
        db.commit()

        return {
            "log_id": log_id,
            "event_type": event_type,
            "severity": severity,
            "warning_count": warning_count,
            "trust_score": trust_score,
            "risk_level": risk_level,
            "flagged": flagged,
            "tool": detected_tool,
            "leakage": leakage_info,
            "disqualified": (new_status == "disqualified")
        }

    @staticmethod
    def get_live_dashboard(db: sqlite3.Connection) -> List[Dict[str, Any]]:
        cursor = db.cursor()
        cursor.execute("""
            SELECT s.id, s.user_id, s.assessment_id, s.status, s.warning_count,
                   s.trust_score, s.risk_level, s.time_remaining_seconds, s.is_paused,
                   u.name as candidate_name, u.email as candidate_email,
                   a.title as assessment_title
            FROM test_sessions s
            JOIN users u ON s.user_id = u.id
            JOIN assessments a ON s.assessment_id = a.id
            WHERE s.status IN ('active', 'face_check', 'paused')
            ORDER BY s.warning_count DESC, s.trust_score ASC
        """)
        rows = cursor.fetchall()
        return [dict(r) for r in rows]

    @staticmethod
    def intervene(db: sqlite3.Connection, examiner_id: str, session_id: str, action_type: str, message: str) -> Dict[str, Any]:
        cursor = db.cursor()
        cursor.execute("SELECT id, status FROM test_sessions WHERE id = ?", (session_id,))
        session = cursor.fetchone()
        if not session:
            raise NotFoundException("Session not found")

        now = datetime.now(timezone.utc).isoformat()
        new_status = session["status"]
        is_paused = 0

        if action_type == "pause":
            new_status = "paused"
            is_paused = 1
        elif action_type == "resume":
            new_status = "active"
            is_paused = 0
        elif action_type == "disqualify":
            new_status = "disqualified"

        cursor.execute("""
            UPDATE test_sessions
            SET status = ?, is_paused = ?, active_warning_message = ?, updated_at = ?
            WHERE id = ?
        """, (new_status, is_paused, message, now, session_id))

        intervention_id = str(uuid.uuid4())
        cursor.execute("""
            INSERT INTO proctor_interventions (id, session_id, examiner_id, action_type, message, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (intervention_id, session_id, examiner_id, action_type, message, now))
        db.commit()

        return {
            "intervention_id": intervention_id,
            "session_id": session_id,
            "action_type": action_type,
            "status": new_status,
            "message": message
        }

    @staticmethod
    def get_audit_report(db: sqlite3.Connection, session_id: str) -> Dict[str, Any]:
        cursor = db.cursor()
        cursor.execute("""
            SELECT s.*, u.name as candidate_name, u.email as candidate_email, a.title as assessment_title
            FROM test_sessions s
            JOIN users u ON s.user_id = u.id
            JOIN assessments a ON s.assessment_id = a.id
            WHERE s.id = ?
        """, (session_id,))
        session = cursor.fetchone()
        if not session:
            raise NotFoundException("Session not found")

        cursor.execute("SELECT * FROM proctoring_logs WHERE session_id = ? ORDER BY timestamp ASC", (session_id,))
        logs = cursor.fetchall()
        formatted_logs = [
            {"event_type": l["event_type"], "severity": l["severity"], "timestamp": l["timestamp"], "payload": json.loads(l["payload"] or "{}")}
            for l in logs
        ]

        trust = session["trust_score"]
        if trust >= 85:
            verdict = "VERIFIED_CLEAN"
        elif trust >= 50:
            verdict = "FLAGGED_MANUAL_REVIEW"
        else:
            verdict = "COMPROMISED_DISQUALIFIED"

        return {
            "report_id": f"REP-{session_id[:8].upper()}",
            "candidate": {"name": session["candidate_name"], "email": session["candidate_email"]},
            "assessment": {"title": session["assessment_title"]},
            "verdict": verdict,
            "trust_score": trust,
            "risk_level": session["risk_level"],
            "session_status": session["status"],
            "total_incidents": len(formatted_logs),
            "timeline": formatted_logs
        }

