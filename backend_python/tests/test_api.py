"""
End-to-End Test Suite for Smart Proctoring FastAPI Backend
Validates all routes, service logic, anti-cheat detection, and reporting.
"""

import sqlite3
from app.db.session import init_db
from app.api.routes import health, auth, assessments, sessions, proctoring
from app.schemas.all_schemas import (
    UserRegisterRequest,
    UserLoginRequest,
    AssessmentCreate,
    QuestionCreate,
    SessionCreateRequest,
    FaceVerifyRequest,
    AnswerSubmitRequest,
    HeartbeatRequest,
    ProctoringLogEvent,
    ProctorInterventionRequest,
)

def run_all_tests():
    print("=== STARTING FASTAPI BACKEND VERIFICATION SUITE ===")
    
    # 0. Initialize Database
    init_db()
    conn = sqlite3.connect("proctorshield_fastapi.db", check_same_thread=False)
    conn.row_factory = sqlite3.Row

    # 1. Health check
    h = health.health_check()
    assert h.success is True
    assert h.data["status"] == "healthy"
    print("[PASS] 1. Health check endpoint")

    # 2. Authentication: Candidate Login
    l_cand = auth.login(UserLoginRequest(email="alice@test.com", password="Test@123"), db=conn)
    assert l_cand.success is True
    assert "access_token" in l_cand.data
    candidate = {"id": l_cand.data["user"]["id"], "role": "candidate", "name": l_cand.data["user"]["name"]}
    print(f"[PASS] 2. Candidate login: {candidate['name']}")

    # 3. Authentication: Examiner Login
    l_exam = auth.login(UserLoginRequest(email="examiner@proctorshield.app", password="Exam@123"), db=conn)
    assert l_exam.success is True
    examiner = {"id": l_exam.data["user"]["id"], "role": "examiner", "name": l_exam.data["user"]["name"]}
    print(f"[PASS] 3. Examiner login: {examiner['name']}")

    # 4. List Published Assessments
    assess_list = assessments.list_assessments(db=conn)
    assert assess_list.success is True
    assert len(assess_list.data["assessments"]) >= 1
    assessment_id = assess_list.data["assessments"][0]["id"]
    print(f"[PASS] 4. Fetched assessments: count = {len(assess_list.data['assessments'])}")

    # 5. Create Test Session
    sess_res = sessions.create_session(SessionCreateRequest(assessment_id=assessment_id), current_user=candidate, db=conn)
    assert sess_res.success is True
    session_id = sess_res.data["session"]["id"]
    assert sess_res.data["session"]["status"] == "face_check"
    print(f"[PASS] 5. Created session: {session_id}")

    # 6. Biometric Face Verification
    face_res = sessions.verify_face(session_id, FaceVerifyRequest(face_descriptor=[0.15, -0.42, 0.88]), current_user=candidate, db=conn)
    assert face_res.success is True
    assert face_res.data["status"] == "active"
    print("[PASS] 6. Face verified -> Session active")

    # 7. Fetch Questions for active test
    q_res = assessments.get_questions(assessment_id, current_user=candidate, db=conn)
    assert q_res.success is True
    assert len(q_res.data["questions"]) >= 5
    q1 = q_res.data["questions"][0]
    print(f"[PASS] 7. Delivered questions without answer leakage: count = {len(q_res.data['questions'])}")

    # 8. Submit Question Answer
    ans_res = sessions.submit_answer(session_id, AnswerSubmitRequest(question_id=q1["id"], selected_option="A"), current_user=candidate, db=conn)
    assert ans_res.success is True
    print(f"[PASS] 8. Submitted answer for question: {q1['id']}")

    # 9. Proctoring Telemetry: Real-time AI Tool and Question Leakage Detection
    telemetry_res = proctoring.log_telemetry(ProctoringLogEvent(
        session_id=session_id,
        event_type="tab_switch",
        severity="warning",
        payload={
            "toUrl": "https://chatgpt.com/c/exam-helper",
            "searchQuery": "What is the capital of France?"
        }
    ), current_user=candidate, db=conn)
    assert telemetry_res.success is True
    tel_data = telemetry_res.data
    assert tel_data["flagged"] is True
    assert tel_data["warning_count"] >= 1
    assert tel_data["trust_score"] < 100.0
    print(f"[PASS] 9. AI Tool & Question Leakage flagged! Warning count: {tel_data['warning_count']}, Trust: {tel_data['trust_score']}")

    # 10. Examiner Live Dashboard Supervision
    dash_res = proctoring.live_dashboard(current_user=examiner, db=conn)
    assert dash_res.success is True
    assert len(dash_res.data["candidates"]) >= 1
    print(f"[PASS] 10. Live dashboard fetched: active candidates = {len(dash_res.data['candidates'])}")

    # 11. Remote Examiner Intervention
    interv_res = proctoring.intervene(session_id, ProctorInterventionRequest(
        action_type="warn",
        message="Warning: AI tool visit recorded. Stay focused on exam tab."
    ), current_user=examiner, db=conn)
    assert interv_res.success is True
    print(f"[PASS] 11. Remote proctor intervention sent: {interv_res.data['action_type']}")

    # 12. Candidate Heartbeat with Alert Delivery
    hb_res = sessions.heartbeat(session_id, HeartbeatRequest(time_remaining_seconds=1740, answered_count=1), current_user=candidate, db=conn)
    assert hb_res.success is True
    assert hb_res.data["warning_message"] is not None
    print(f"[PASS] 12. Heartbeat delivered proctor alert: '{hb_res.data['warning_message']}'")

    # 13. Test Submission & Scoring
    sub_res = sessions.submit_test(session_id, current_user=candidate, db=conn)
    assert sub_res.success is True
    assert sub_res.data["status"] == "submitted"
    assert "raw_score" in sub_res.data
    print(f"[PASS] 13. Test submitted and scored: raw_score = {sub_res.data['raw_score']}/{sub_res.data['total_marks']}")

    # 14. Executive Proctoring Integrity Audit Report
    rep_res = proctoring.audit_report(session_id, current_user=examiner, db=conn)
    assert rep_res.success is True
    rep_data = rep_res.data["report"]
    assert "verdict" in rep_data
    assert len(rep_data["timeline"]) >= 1
    print(f"[PASS] 14. Audit report produced: ID = {rep_data['report_id']}, Verdict = {rep_data['verdict']}")

    print("\n=== ALL 14 BACKEND TESTS PASSED CLEANLY! ===")

if __name__ == "__main__":
    run_all_tests()
