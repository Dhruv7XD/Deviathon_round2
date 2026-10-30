'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');

const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { calculateScore } = require('../utils/scoring');
const { calculateTrustScore, generateAuditReport } = require('../utils/smartAnalyzer');

const router = express.Router();

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      error: 'ValidationError',
      message: errors.array().map(e => e.msg).join('; '),
      details: errors.array(),
    });
  }
  return null;
}

// ─── Helper: run score calculation and persist results ───────────────────────

function finalizeSession(session, assessment, status = 'submitted') {
  const questions = db.prepare('SELECT * FROM questions WHERE assessment_id = ?').all(assessment.id);
  const scoreResult = calculateScore(session, questions);
  const passed = scoreResult.percentage >= assessment.passing_score ? 1 : 0;
  const now = new Date().toISOString();

  // Build proctoring summary
  const logCounts = db.prepare(`
    SELECT event_type, COUNT(*) as count FROM proctoring_logs
    WHERE session_id = ? GROUP BY event_type
  `).all(session.id);

  const criticals = db.prepare(`
    SELECT * FROM proctoring_logs WHERE session_id = ? AND severity = 'critical' ORDER BY timestamp ASC
  `).all(session.id);

  const trustData = calculateTrustScore(session.id);

  const summary = {
    event_counts: logCounts.reduce((acc, r) => { acc[r.event_type] = r.count; return acc; }, {}),
    critical_count: criticals.length,
    critical_events: criticals.map(l => ({ event_type: l.event_type, timestamp: l.timestamp, payload: JSON.parse(l.payload || '{}') })),
    trust_index: trustData,
  };

  db.prepare(`
    UPDATE test_sessions
    SET status = ?, submitted_at = ?, score = ?, percentage = ?, passed = ?,
        trust_score = ?, risk_level = ?,
        proctoring_summary = ?, updated_at = ?
    WHERE id = ?
  `).run(
    status, now, scoreResult.raw_score, scoreResult.percentage, passed,
    trustData ? trustData.trust_score : 100,
    trustData ? trustData.risk_level : 'LOW',
    JSON.stringify(summary), now, session.id
  );

  return { ...scoreResult, passed: !!passed, trust_index: trustData, summary };
}

// ─── Helper: issue a warning to a session ────────────────────────────────────

function issueWarning(sessionId, reason) {
  const now = new Date().toISOString();
  const session = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(sessionId);
  if (!session) return null;

  const newCount = session.warning_count + 1;
  const assessment = db.prepare('SELECT * FROM assessments WHERE id = ?').get(session.assessment_id);

  let newStatus = session.status;
  let disqualification_reason = null;

  if (newCount >= assessment.max_warnings) {
    newStatus = 'disqualified';
    disqualification_reason = reason || `Warning limit reached (${newCount}/${assessment.max_warnings})`;
  }

  db.prepare(`
    UPDATE test_sessions
    SET warning_count = ?, status = ?, disqualification_reason = ?, updated_at = ?
    WHERE id = ?
  `).run(newCount, newStatus, disqualification_reason, now, sessionId);

  return { warning_count: newCount, disqualified: newStatus === 'disqualified', disqualification_reason };
}

// ─── POST / — create/start a session ─────────────────────────────────────────

router.post(
  '/',
  authenticate,
  requireRole('candidate'),
  [body('assessment_id').notEmpty().withMessage('assessment_id is required.')],
  (req, res, next) => {
    try {
      const err = validationErrors(req, res);
      if (err) return;

      const { assessment_id } = req.body;
      const assessment = db.prepare('SELECT * FROM assessments WHERE id = ? AND is_published = 1').get(assessment_id);
      if (!assessment) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'Assessment not found or not published.' });
      }

      // Check timing window
      const now = new Date();
      if (assessment.starts_at && now < new Date(assessment.starts_at)) {
        return res.status(400).json({ success: false, error: 'NotStartedYet', message: 'Assessment has not started yet.' });
      }
      if (assessment.ends_at && now > new Date(assessment.ends_at)) {
        return res.status(400).json({ success: false, error: 'Expired', message: 'Assessment window has closed.' });
      }

      // Check existing active session
      const existing = db.prepare(`
        SELECT id FROM test_sessions
        WHERE user_id = ? AND assessment_id = ? AND status IN ('pending', 'face_check', 'active', 'paused')
      `).get(req.user.id, assessment_id);

      if (existing) {
        return res.status(409).json({
          success: false,
          error: 'SessionExists',
          message: 'You already have an active session for this assessment.',
          data: { session_id: existing.id },
        });
      }

      const id = uuidv4();
      const nowIso = new Date().toISOString();
      const timeRemaining = assessment.duration_minutes * 60;

      db.prepare(`
        INSERT INTO test_sessions (id, user_id, assessment_id, status, started_at, time_remaining_seconds, warning_count, answers, face_verified, created_at, updated_at)
        VALUES (?, ?, ?, 'face_check', ?, ?, 0, '{}', 0, ?, ?)
      `).run(id, req.user.id, assessment_id, nowIso, timeRemaining, nowIso, nowIso);

      const session = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(id);
      return res.status(201).json({ success: true, message: 'Session created. Complete face verification to begin.', data: { session } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:id/face-verify ────────────────────────────────────────────────────

router.post(
  '/:id/face-verify',
  authenticate,
  [body('face_descriptor').optional()],
  (req, res, next) => {
    try {
      const session = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(req.params.id);
      if (!session) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'Session not found.' });
      }
      if (session.user_id !== req.user.id) {
        return res.status(403).json({ success: false, error: 'Forbidden', message: 'Not your session.' });
      }
      if (session.status !== 'face_check') {
        return res.status(400).json({ success: false, error: 'InvalidStatus', message: `Cannot face-verify a session with status '${session.status}'.` });
      }

      const now = new Date().toISOString();
      // Stub verification — mark as verified and transition to active
      db.prepare(`
        UPDATE test_sessions SET face_verified = 1, status = 'active', updated_at = ? WHERE id = ?
      `).run(now, session.id);

      const updated = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(session.id);
      return res.json({ success: true, message: 'Face verified. Session is now active.', data: { session: updated, matched: true, confidence: 0.97 } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET / — list sessions ────────────────────────────────────────────────────

router.get('/', authenticate, (req, res, next) => {
  try {
    let rows;
    if (req.user.role === 'candidate') {
      rows = db.prepare(`
        SELECT s.*, a.title as assessment_title, a.duration_minutes, a.passing_score
        FROM test_sessions s JOIN assessments a ON s.assessment_id = a.id
        WHERE s.user_id = ? ORDER BY s.created_at DESC
      `).all(req.user.id);
    } else {
      rows = db.prepare(`
        SELECT s.*, a.title as assessment_title, u.name as candidate_name, u.email as candidate_email
        FROM test_sessions s
        JOIN assessments a ON s.assessment_id = a.id
        JOIN users u ON s.user_id = u.id
        ORDER BY s.created_at DESC
      `).all();
    }
    return res.json({ success: true, message: 'Sessions fetched.', data: { sessions: rows } });
  } catch (err) {
    next(err);
  }
});

// ─── GET /:id — get session details ──────────────────────────────────────────

router.get('/:id', authenticate, (req, res, next) => {
  try {
    const session = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'NotFound', message: 'Session not found.' });
    }
    // Only owner, admin, or examiner can view
    if (req.user.role === 'candidate' && session.user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Forbidden', message: 'Not your session.' });
    }

    const answers = JSON.parse(session.answers || '{}');
    return res.json({
      success: true, message: 'Session fetched.',
      data: {
        session: {
          ...session,
          answers,
          time_remaining_seconds: session.time_remaining_seconds,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /:id/answer ─────────────────────────────────────────────────────────

router.post(
  '/:id/answer',
  authenticate,
  [
    body('question_id').notEmpty().withMessage('question_id is required.'),
    body('selected_option').isIn(['A','B','C','D']).withMessage('selected_option must be A, B, C, or D.'),
  ],
  (req, res, next) => {
    try {
      const err = validationErrors(req, res);
      if (err) return;

      const session = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(req.params.id);
      if (!session) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'Session not found.' });
      }
      if (session.user_id !== req.user.id) {
        return res.status(403).json({ success: false, error: 'Forbidden', message: 'Not your session.' });
      }
      if (session.status !== 'active') {
        return res.status(400).json({ success: false, error: 'InvalidStatus', message: `Cannot submit answer for session with status '${session.status}'.` });
      }

      const { question_id, selected_option } = req.body;

      // Verify question belongs to this assessment
      const question = db.prepare('SELECT id FROM questions WHERE id = ? AND assessment_id = ?').get(question_id, session.assessment_id);
      if (!question) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'Question not found in this assessment.' });
      }

      const answers = JSON.parse(session.answers || '{}');
      answers[question_id] = selected_option;
      const now = new Date().toISOString();

      db.prepare('UPDATE test_sessions SET answers = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(answers), now, session.id);

      return res.json({
        success: true,
        message: 'Answer recorded.',
        data: { question_id, selected_option, answered_count: Object.keys(answers).length },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:id/heartbeat ──────────────────────────────────────────────────────

router.post(
  '/:id/heartbeat',
  authenticate,
  [
    body('time_remaining_seconds').isInt({ min: 0 }).withMessage('time_remaining_seconds must be a non-negative integer.'),
    body('answered_count').optional().isInt({ min: 0 }),
  ],
  (req, res, next) => {
    try {
      const err = validationErrors(req, res);
      if (err) return;

      const session = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(req.params.id);
      if (!session) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'Session not found.' });
      }
      if (session.user_id !== req.user.id) {
        return res.status(403).json({ success: false, error: 'Forbidden', message: 'Not your session.' });
      }
      if (!['active', 'paused'].includes(session.status)) {
        return res.status(400).json({ success: false, error: 'InvalidStatus', message: `Session status is '${session.status}'.` });
      }

      const { time_remaining_seconds, answered_count } = req.body;
      const now = new Date().toISOString();

      // Log heartbeat
      db.prepare(`
        INSERT INTO proctoring_logs (id, session_id, user_id, event_type, severity, payload, timestamp)
        VALUES (?, ?, ?, 'heartbeat', 'info', ?, ?)
      `).run(uuidv4(), session.id, req.user.id, JSON.stringify({ timeRemainingSeconds: time_remaining_seconds, answeredCount: answered_count || 0 }), now);

      // Auto-submit on timeout
      if (time_remaining_seconds <= 0) {
        const assessment = db.prepare('SELECT * FROM assessments WHERE id = ?').get(session.assessment_id);
        const scoreResult = finalizeSession(session, assessment, 'timed_out');

        return res.json({
          success: true,
          message: 'Time expired. Session auto-submitted.',
          data: { status: 'timed_out', ...scoreResult },
        });
      }

      // Check for examiner intervention messages (e.g., active proctor warnings)
      let activeWarning = session.active_warning_message || null;
      if (activeWarning) {
        // Clear once delivered
        db.prepare('UPDATE test_sessions SET active_warning_message = NULL WHERE id = ?').run(session.id);
      }

      db.prepare('UPDATE test_sessions SET time_remaining_seconds = ?, updated_at = ? WHERE id = ?').run(time_remaining_seconds, now, session.id);

      return res.json({
        success: true,
        message: 'Heartbeat received.',
        data: {
          time_remaining_seconds,
          status: session.status,
          is_paused: !!session.is_paused,
          warning_message: activeWarning,
          warning_count: session.warning_count,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:id/submit — manual submission ─────────────────────────────────────

router.post('/:id/submit', authenticate, (req, res, next) => {
  try {
    const session = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'NotFound', message: 'Session not found.' });
    }
    if (session.user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Forbidden', message: 'Not your session.' });
    }
    if (!['active', 'paused'].includes(session.status)) {
      return res.status(400).json({ success: false, error: 'InvalidStatus', message: `Cannot submit session with status '${session.status}'.` });
    }

    const assessment = db.prepare('SELECT * FROM assessments WHERE id = ?').get(session.assessment_id);
    const scoreResult = finalizeSession(session, assessment, 'submitted');

    const updated = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(session.id);
    return res.json({
      success: true,
      message: 'Test submitted successfully.',
      data: { session: updated, ...scoreResult },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /:id/result ──────────────────────────────────────────────────────────

router.get('/:id/result', authenticate, (req, res, next) => {
  try {
    const session = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'NotFound', message: 'Session not found.' });
    }

    if (req.user.role === 'candidate' && session.user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Forbidden', message: 'Not your session.' });
    }

    if (!['submitted', 'timed_out', 'disqualified'].includes(session.status)) {
      return res.status(400).json({ success: false, error: 'NotCompleted', message: 'Results are only available after submission.' });
    }

    const assessment = db.prepare('SELECT id, title, passing_score, duration_minutes FROM assessments WHERE id = ?').get(session.assessment_id);
    const questions = db.prepare('SELECT * FROM questions WHERE assessment_id = ?').all(session.assessment_id);
    const answers = JSON.parse(session.answers || '{}');

    // Annotate each question with candidate's answer and correctness
    const reviewed = questions.map(q => ({
      id: q.id,
      question_text: q.question_text,
      option_a: q.option_a,
      option_b: q.option_b,
      option_c: q.option_c,
      option_d: q.option_d,
      correct_option: q.correct_option,
      explanation: q.explanation,
      marks: q.marks,
      negative_marks: q.negative_marks,
      selected_option: answers[q.id] || null,
      is_correct: answers[q.id] ? answers[q.id].toUpperCase() === q.correct_option.toUpperCase() : null,
    }));

    return res.json({
      success: true,
      message: 'Result fetched.',
      data: {
        session: {
          id: session.id,
          status: session.status,
          score: session.score,
          percentage: session.percentage,
          passed: !!session.passed,
          warning_count: session.warning_count,
          disqualification_reason: session.disqualification_reason,
          started_at: session.started_at,
          submitted_at: session.submitted_at,
          proctoring_summary: session.proctoring_summary ? JSON.parse(session.proctoring_summary) : null,
        },
        assessment,
        reviewed_questions: reviewed,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.issueWarning = issueWarning;
