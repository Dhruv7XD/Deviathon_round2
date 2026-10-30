'use strict';

const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// Resolve DB path from env
const dbPath = process.env.DB_PATH || './data/proctorshield.db';
const resolvedPath = path.resolve(dbPath);

// Ensure data directory exists
const dir = path.dirname(resolvedPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new DatabaseSync(resolvedPath);

// Enable WAL mode for performance
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA foreign_keys=ON;');

// ─── Create Tables ───────────────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'candidate',
  face_enrolled INTEGER NOT NULL DEFAULT 0,
  face_descriptor TEXT,
  otp_code TEXT,
  otp_expires_at TEXT,
  otp_verified INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  max_warnings INTEGER NOT NULL DEFAULT 3,
  passing_score INTEGER NOT NULL DEFAULT 60,
  randomize_questions INTEGER NOT NULL DEFAULT 1,
  allow_back_navigation INTEGER NOT NULL DEFAULT 0,
  is_published INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id)
);
`);

db.exec(`
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
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (assessment_id) REFERENCES assessments(id) ON DELETE CASCADE
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS test_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  submitted_at TEXT,
  time_remaining_seconds INTEGER,
  warning_count INTEGER NOT NULL DEFAULT 0,
  disqualification_reason TEXT,
  answers TEXT NOT NULL DEFAULT '{}',
  score REAL,
  percentage REAL,
  passed INTEGER,
  face_verified INTEGER NOT NULL DEFAULT 0,
  proctoring_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (assessment_id) REFERENCES assessments(id)
);
`);

db.exec(`
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
`);

db.exec(`
CREATE TABLE IF NOT EXISTS otp_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login',
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS proctor_interventions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  examiner_id TEXT NOT NULL,
  action_type TEXT NOT NULL, -- 'warn' | 'pause' | 'resume' | 'disqualify' | 'request_360_scan'
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES test_sessions(id),
  FOREIGN KEY (examiner_id) REFERENCES users(id)
);
`);

// ─── Migrations for existing test_sessions table ──────────────────────────────
const sessionColumns = [
  'ALTER TABLE test_sessions ADD COLUMN trust_score REAL DEFAULT 100;',
  "ALTER TABLE test_sessions ADD COLUMN risk_level TEXT DEFAULT 'LOW';",
  "ALTER TABLE test_sessions ADD COLUMN suspicion_flags TEXT DEFAULT '[]';",
  'ALTER TABLE test_sessions ADD COLUMN active_warning_message TEXT;',
  'ALTER TABLE test_sessions ADD COLUMN is_paused INTEGER DEFAULT 0;',
];

for (const sql of sessionColumns) {
  try {
    db.exec(sql);
  } catch (err) {
    // Column already exists, ignore
  }
}

// ─── Indexes ──────────────────────────────────────────────────────────────────

db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON test_sessions(user_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_assessment ON test_sessions(assessment_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_session ON proctoring_logs(session_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_type ON proctoring_logs(event_type);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON proctoring_logs(timestamp);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_questions_assessment ON questions(assessment_id);`);

// ─── Seed Data ────────────────────────────────────────────────────────────────

function seedIfNeeded() {
  const existing = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (existing.count > 0) return; // already seeded

  const now = new Date().toISOString();

  const insertUser = db.prepare(`
    INSERT INTO users (id, name, email, phone, password_hash, role, face_enrolled, otp_verified, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)
  `);

  const users = [
    { id: uuidv4(), name: 'Admin', email: 'admin@proctorshield.app', phone: null, password: 'Admin@123', role: 'admin' },
    { id: uuidv4(), name: 'Dr. Smith', email: 'examiner@proctorshield.app', phone: null, password: 'Exam@123', role: 'examiner' },
    { id: uuidv4(), name: 'Alice', email: 'alice@test.com', phone: null, password: 'Test@123', role: 'candidate' },
    { id: uuidv4(), name: 'Bob', email: 'bob@test.com', phone: null, password: 'Test@123', role: 'candidate' },
  ];

  const seededUsers = users.map(u => {
    const hash = bcrypt.hashSync(u.password, 10);
    insertUser.run(u.id, u.name, u.email, u.phone, hash, u.role, now, now);
    return u;
  });

  // Find examiner to use as creator
  const examiner = seededUsers.find(u => u.role === 'examiner');

  const assessmentId = uuidv4();
  db.prepare(`
    INSERT INTO assessments (id, title, description, created_by, duration_minutes, max_warnings, passing_score, randomize_questions, allow_back_navigation, is_published, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    assessmentId,
    'General Knowledge Quiz',
    'A basic general knowledge quiz covering geography, science, math, and literature.',
    examiner.id,
    30,
    3,
    60,
    1,
    0,
    1,
    now,
    now
  );

  const seedQuestions = [
    { text: 'What is the capital of France?', a: 'Paris', b: 'London', c: 'Berlin', d: 'Madrid', correct: 'A', explanation: 'Paris is the capital city of France.' },
    { text: 'What does HTTP stand for?', a: 'HyperText Transfer Protocol', b: 'High Transfer Text Protocol', c: 'Hyper Terminal Transfer Protocol', d: 'HyperText Transmission Port', correct: 'A', explanation: 'HTTP stands for HyperText Transfer Protocol.' },
    { text: 'Which planet is known as the Red Planet?', a: 'Venus', b: 'Jupiter', c: 'Mars', d: 'Saturn', correct: 'C', explanation: 'Mars is known as the Red Planet due to its reddish appearance.' },
    { text: 'What is 15% of 200?', a: '25', b: '30', c: '35', d: '40', correct: 'B', explanation: '15% of 200 = 0.15 × 200 = 30.' },
    { text: "Who wrote 'Romeo and Juliet'?", a: 'Charles Dickens', b: 'William Shakespeare', c: 'Mark Twain', d: 'Jane Austen', correct: 'B', explanation: 'Romeo and Juliet was written by William Shakespeare.' },
  ];

  const insertQuestion = db.prepare(`
    INSERT INTO questions (id, assessment_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation, marks, negative_marks, order_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
  `);

  seedQuestions.forEach((q, idx) => {
    insertQuestion.run(uuidv4(), assessmentId, q.text, q.a, q.b, q.c, q.d, q.correct, q.explanation, idx, now);
  });

  console.log('[DB] Seed data inserted successfully.');
}

try {
  seedIfNeeded();
} catch (err) {
  console.error('[DB] Seed error:', err.message);
}

module.exports = db;
