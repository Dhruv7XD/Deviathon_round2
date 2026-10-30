import sqlite3
import os
import json
import uuid
from datetime import datetime, timezone
from app.core.config import settings
from app.core.security import hash_password

def get_db():
    conn = sqlite3.connect(settings.DATABASE_URL, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    conn = sqlite3.connect(settings.DATABASE_URL)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    cursor = conn.cursor()

    cursor.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'candidate',
        face_enrolled INTEGER NOT NULL DEFAULT 0,
        face_descriptor TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assessments (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        created_by TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL DEFAULT 30,
        max_warnings INTEGER NOT NULL DEFAULT 3,
        passing_score INTEGER NOT NULL DEFAULT 60,
        randomize_questions INTEGER NOT NULL DEFAULT 1,
        is_published INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        assessment_id TEXT NOT NULL,
        question_text TEXT NOT NULL,
        option_a TEXT NOT NULL,
        option_b TEXT NOT NULL,
        option_c TEXT NOT NULL,
        option_d TEXT NOT NULL,
        correct_option TEXT NOT NULL,
        explanation TEXT,
        marks INTEGER NOT NULL DEFAULT 1,
        negative_marks REAL NOT NULL DEFAULT 0,
        order_index INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        FOREIGN KEY (assessment_id) REFERENCES assessments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS test_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        assessment_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT,
        submitted_at TEXT,
        time_remaining_seconds INTEGER,
        warning_count INTEGER NOT NULL DEFAULT 0,
        trust_score REAL NOT NULL DEFAULT 100.0,
        risk_level TEXT NOT NULL DEFAULT 'LOW',
        is_paused INTEGER NOT NULL DEFAULT 0,
        active_warning_message TEXT,
        disqualification_reason TEXT,
        answers TEXT NOT NULL DEFAULT '{}',
        score REAL,
        percentage REAL,
        passed INTEGER,
        face_verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (assessment_id) REFERENCES assessments(id)
    );

    CREATE TABLE IF NOT EXISTS proctoring_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        payload TEXT NOT NULL DEFAULT '{}',
        timestamp TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES test_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS proctor_interventions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        examiner_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES test_sessions(id),
        FOREIGN KEY (examiner_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON test_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_assessment ON test_sessions(assessment_id);
    CREATE INDEX IF NOT EXISTS idx_logs_session ON proctoring_logs(session_id);
    CREATE INDEX IF NOT EXISTS idx_questions_assessment ON questions(assessment_id);
    """)

    # Seed initial test users and assessment if not present
    cursor.execute("SELECT COUNT(*) FROM users")
    if cursor.fetchone()[0] == 0:
        now = datetime.now(timezone.utc).isoformat()
        admin_id = str(uuid.uuid4())
        examiner_id = str(uuid.uuid4())
        candidate_id = str(uuid.uuid4())
        
        cursor.execute("""
            INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (admin_id, "Admin User", "admin@proctorshield.app", hash_password("Admin@123"), "admin", now, now))

        cursor.execute("""
            INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (examiner_id, "Dr. Examiner", "examiner@proctorshield.app", hash_password("Exam@123"), "examiner", now, now))

        cursor.execute("""
            INSERT INTO users (id, name, email, password_hash, role, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (candidate_id, "Alice Candidate", "alice@test.com", hash_password("Test@123"), "candidate", now, now))

        assessment_id = "cb2c4a6f-3fdc-4e4e-badb-8fa4541ba692"
        cursor.execute("""
            INSERT INTO assessments (id, title, description, created_by, duration_minutes, max_warnings, passing_score, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (assessment_id, "General Knowledge & Logic Quiz", "Official proctored examination", examiner_id, 30, 3, 60, now, now))

        questions = [
            ("What is the capital of France?", "Paris", "London", "Berlin", "Madrid", "A", 1),
            ("What does HTTP stand for?", "HyperText Transfer Protocol", "High Text Transfer Protocol", "Hyper Transfer Protocol", "Hyper Terminal Text Protocol", "A", 1),
            ("Which planet is known as the Red Planet?", "Venus", "Jupiter", "Mars", "Saturn", "C", 1),
            ("What is 15% of 200?", "25", "30", "35", "40", "B", 1),
            ("Who wrote Romeo and Juliet?", "Charles Dickens", "William Shakespeare", "Mark Twain", "Jane Austen", "B", 1)
        ]

        for q_text, opt_a, opt_b, opt_c, opt_d, ans, order_idx in questions:
            cursor.execute("""
                INSERT INTO questions (id, assessment_id, question_text, option_a, option_b, option_c, option_d, correct_option, order_index, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (str(uuid.uuid4()), assessment_id, q_text, opt_a, opt_b, opt_c, opt_d, ans, order_idx, now))

        conn.commit()

    conn.close()
