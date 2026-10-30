'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');

const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { telemetryLimiter } = require('../middleware/rateLimiter');
const { detectAITool } = require('../utils/aiDetector');
const {
  detectQuestionLeakage,
  detectKeystrokeAnomaly,
  calculateTrustScore,
  generateAuditReport,
} = require('../utils/smartAnalyzer');
const {
  syncLogToSupabase,
  syncInterventionToSupabase,
  syncSessionToSupabase,
} = require('../utils/supabaseSync');

const router = express.Router();

const VALID_EVENT_TYPES = [
  'tab_switch', 'ai_tool_access', 'question_leakage',
  'face_absent', 'face_mismatch', 'multiple_faces', 'face_unverified',
  'keystroke_anomaly', 'mouse_anomaly', 'copy_paste',
  'right_click', 'fullscreen_exit', 'warning_issued',
  'heartbeat', 'screenshot_captured', 'audio_anomaly',
  'devtools_opened', 'browser_extension_detected', 'speech_detected',
];

const VALID_SEVERITIES = ['info', 'warning', 'critical'];

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

// ─── Core log ingestion logic (shared between single and batch) ───────────────

function ingestEvent(eventData, userId) {
  let { session_id, event_type, severity = 'info', payload = {} } = eventData;

  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
  }

  // Validate session
  const session = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(session_id);
  if (!session) {
    return { success: false, error: 'SessionNotFound', message: 'Session not found.' };
  }

  const assessment = db.prepare('SELECT * FROM assessments WHERE id = ?').get(session.assessment_id);

  let flagged = false;
  let detectedTool = null;
  let leakageResult = null;
  let disqualified = false;
  let warning_count = session.warning_count;
  let warningReason = null;

  // 1. AI Tool Detection
  const urlToCheck = payload.toUrl || payload.url || '';
  const aiDetection = detectAITool(urlToCheck);

  if (aiDetection.detected || event_type === 'ai_tool_access') {
    event_type = 'ai_tool_access';
    severity = 'critical';
    detectedTool = aiDetection.tool || payload.tool || 'Unknown AI Tool';
    payload = { ...payload, tool: detectedTool, flaggedAt: new Date().toISOString() };
    flagged = true;
    warningReason = `AI Tool access detected: ${detectedTool}`;
  }

  // 2. Question Prompt Leakage Detection (Semantic match with assessment questions)
  const queryOrText = payload.searchQuery || payload.pastedText || payload.prompt || payload.query || '';
  if (queryOrText && assessment) {
    const leakage = detectQuestionLeakage(queryOrText, assessment.id);
    if (leakage.leakageDetected) {
      leakageResult = leakage;
      event_type = 'question_leakage';
      severity = 'critical';
      payload = {
        ...payload,
        question_leakage: true,
        similarity_score: leakage.similarityScore,
        matched_question_id: leakage.matchedQuestionId,
        matched_snippet: leakage.matchedSnippet,
      };
      flagged = true;
      warningReason = `Direct Question Leakage detected (similarity ${Math.round(leakage.similarityScore * 100)}%)`;
    }
  }

  // 3. Keystroke / Macro Burst Detection
  if (event_type === 'keystroke_anomaly' || payload.charCount) {
    const keyAnomaly = detectKeystrokeAnomaly(payload);
    if (keyAnomaly.anomalous) {
      event_type = 'keystroke_anomaly';
      severity = 'warning';
      payload = { ...payload, anomaly_details: keyAnomaly };
    }
  }

  // 4. Warning & Disqualification Escalation
  if (flagged || severity === 'critical') {
    warning_count = session.warning_count + 1;
    const now = new Date().toISOString();

    let newStatus = session.status;
    let disqualification_reason = session.disqualification_reason;

    if (warning_count >= assessment.max_warnings) {
      newStatus = 'disqualified';
      disqualification_reason = warningReason || `Exceeded maximum allowed warnings (${assessment.max_warnings})`;
      disqualified = true;
    }

    db.prepare(`
      UPDATE test_sessions
      SET warning_count = ?, status = ?, disqualification_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(warning_count, newStatus, disqualification_reason, now, session_id);
  }

  const id = uuidv4();
  const timestamp = new Date().toISOString();

  db.prepare(`
    INSERT INTO proctoring_logs (id, session_id, user_id, event_type, severity, payload, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, session_id, userId, event_type, severity, JSON.stringify(payload), timestamp);

  // Background sync to Supabase Realtime
  syncLogToSupabase({ id, session_id, user_id: userId, event_type, severity, payload, timestamp });

  // Recalculate real-time Trust Score & Risk Level
  const trustData = calculateTrustScore(session_id);

  // Background sync session status & trust index to Supabase
  syncSessionToSupabase({
    id: session_id,
    user_id: userId,
    assessment_id: session.assessment_id,
    status: session.status,
    warning_count,
    trust_score: trustData ? trustData.trust_score : 100,
    risk_level: trustData ? trustData.risk_level : 'LOW',
    time_remaining_seconds: session.time_remaining_seconds,
    is_paused: !!session.is_paused,
    disqualification_reason: session.disqualification_reason,
  });

  const result = {
    success: true,
    log_id: id,
    event_type,
    severity,
    timestamp,
    warning_count,
    trust_score: trustData ? trustData.trust_score : 100,
    risk_level: trustData ? trustData.risk_level : 'LOW',
  };

  if (flagged) {
    result.flagged = true;
    result.disqualified = disqualified;
    if (detectedTool) result.tool = detectedTool;
    if (leakageResult) result.leakage = leakageResult;
  }

  return result;
}

// ─── POST /log — single event ingestion ───────────────────────────────────────

router.post(
  '/log',
  authenticate,
  telemetryLimiter,
  [
    body('session_id').notEmpty().withMessage('session_id is required.'),
    body('event_type').isIn(VALID_EVENT_TYPES).withMessage(`event_type must be one of: ${VALID_EVENT_TYPES.join(', ')}`),
    body('severity').optional().isIn(VALID_SEVERITIES).withMessage(`severity must be: ${VALID_SEVERITIES.join(', ')}`),
    body('payload').optional(),
  ],
  (req, res, next) => {
    try {
      const err = validationErrors(req, res);
      if (err) return;

      const result = ingestEvent(req.body, req.user.id);
      if (!result.success) {
        return res.status(404).json(result);
      }

      res.setHeader('X-Warning-Count', String(result.warning_count));
      res.setHeader('X-Session-Status', result.disqualified ? 'disqualified' : 'active');
      res.setHeader('X-Trust-Score', String(result.trust_score));

      return res.status(201).json({
        success: true,
        message: 'Telemetry logged successfully.',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /log/batch — batch ingestion (buffered telemetry, max 50) ───────────

router.post(
  '/log/batch',
  authenticate,
  telemetryLimiter,
  [
    body('events').isArray({ min: 1, max: 50 }).withMessage('events must be an array of 1 to 50 items.'),
    body('events.*.session_id').notEmpty().withMessage('Each event requires session_id.'),
    body('events.*.event_type').isIn(VALID_EVENT_TYPES).withMessage('Invalid event_type in array.'),
    body('events.*.severity').optional().isIn(VALID_SEVERITIES),
    body('events.*.payload').optional(),
  ],
  (req, res, next) => {
    try {
      const err = validationErrors(req, res);
      if (err) return;

      const results = req.body.events.map(event => ingestEvent(event, req.user.id));
      const failed = results.filter(r => !r.success);

      return res.status(201).json({
        success: true,
        message: `${results.length - failed.length}/${results.length} events logged.`,
        data: {
          processed: results.length,
          results,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /live-dashboard — real-time examiner monitoring grid ─────────────────

router.get('/live-dashboard', authenticate, requireRole('examiner', 'admin'), (req, res, next) => {
  try {
    const activeSessions = db.prepare(`
      SELECT s.id, s.user_id, s.assessment_id, s.status, s.started_at,
             s.time_remaining_seconds, s.warning_count, s.trust_score, s.risk_level,
             s.is_paused,
             u.name as candidate_name, u.email as candidate_email,
             a.title as assessment_title, a.duration_minutes
      FROM test_sessions s
      JOIN users u ON s.user_id = u.id
      JOIN assessments a ON s.assessment_id = a.id
      WHERE s.status IN ('active', 'face_check', 'paused')
      ORDER BY s.warning_count DESC, s.trust_score ASC
    `).all();

    // Attach latest critical violation for each active candidate
    const enriched = activeSessions.map(sess => {
      const latestViolation = db.prepare(`
        SELECT event_type, severity, payload, timestamp
        FROM proctoring_logs
        WHERE session_id = ? AND severity IN ('warning', 'critical')
        ORDER BY timestamp DESC LIMIT 1
      `).get(sess.id);

      return {
        ...sess,
        trust_score: sess.trust_score !== null ? sess.trust_score : 100,
        risk_level: sess.risk_level || 'LOW',
        latest_violation: latestViolation ? {
          ...latestViolation,
          payload: JSON.parse(latestViolation.payload || '{}')
        } : null,
      };
    });

    return res.json({
      success: true,
      message: 'Live proctoring dashboard fetched.',
      data: {
        active_candidates_count: enriched.length,
        candidates: enriched,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /trust-score/:session_id — detailed trust index calculation ──────────

router.get('/trust-score/:session_id', authenticate, (req, res, next) => {
  try {
    const trustData = calculateTrustScore(req.params.session_id);
    if (!trustData) {
      return res.status(404).json({ success: false, error: 'NotFound', message: 'Session not found.' });
    }

    return res.json({
      success: true,
      message: 'Trust score calculated.',
      data: trustData,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /audit-report/:session_id — executive proctoring audit report ────────

router.get('/audit-report/:session_id', authenticate, (req, res, next) => {
  try {
    const report = generateAuditReport(req.params.session_id);
    if (!report) {
      return res.status(404).json({ success: false, error: 'NotFound', message: 'Session not found.' });
    }

    return res.json({
      success: true,
      message: 'Proctoring audit report generated.',
      data: { report },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /intervene/:session_id — live proctor intervention ─────────────────

router.post(
  '/intervene/:session_id',
  authenticate,
  requireRole('examiner', 'admin'),
  [
    body('action_type')
      .isIn(['warn', 'pause', 'resume', 'disqualify', 'request_360_scan'])
      .withMessage('action_type must be: warn, pause, resume, disqualify, or request_360_scan.'),
    body('message').trim().notEmpty().withMessage('Intervention message is required.'),
  ],
  (req, res, next) => {
    try {
      const err = validationErrors(req, res);
      if (err) return;

      const session = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(req.params.session_id);
      if (!session) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'Session not found.' });
      }

      const { action_type, message } = req.body;
      const now = new Date().toISOString();
      const interventionId = uuidv4();

      // Log intervention
      db.prepare(`
        INSERT INTO proctor_interventions (id, session_id, examiner_id, action_type, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(interventionId, session.id, req.user.id, action_type, message, now);

      let newStatus = session.status;
      let isPaused = session.is_paused || 0;
      let disqualificationReason = session.disqualification_reason;

      if (action_type === 'pause') {
        newStatus = 'paused';
        isPaused = 1;
      } else if (action_type === 'resume') {
        newStatus = 'active';
        isPaused = 0;
      } else if (action_type === 'disqualify') {
        newStatus = 'disqualified';
        disqualificationReason = `Examiner intervention: ${message}`;
      }

      db.prepare(`
        UPDATE test_sessions
        SET status = ?, is_paused = ?, active_warning_message = ?, disqualification_reason = ?, updated_at = ?
        WHERE id = ?
      `).run(newStatus, isPaused, message, disqualificationReason, now, session.id);

      // Also record in proctoring logs for timeline completeness
      db.prepare(`
        INSERT INTO proctoring_logs (id, session_id, user_id, event_type, severity, payload, timestamp)
        VALUES (?, ?, ?, 'warning_issued', 'warning', ?, ?)
      `).run(uuidv4(), session.id, session.user_id, JSON.stringify({ action_type, message, by: req.user.name }), now);

      // Realtime push to Supabase to trigger instant candidate alerts
      syncInterventionToSupabase({
        id: interventionId,
        session_id: session.id,
        examiner_id: req.user.id,
        action_type,
        message,
        created_at: now,
      });

      return res.json({
        success: true,
        message: `Intervention '${action_type}' applied to candidate session.`,
        data: {
          session_id: session.id,
          status: newStatus,
          is_paused: !!isPaused,
          message_delivered: message,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /logs/:session_id ────────────────────────────────────────────────────

router.get('/logs/:session_id', authenticate, (req, res, next) => {
  try {
    const session = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(req.params.session_id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'NotFound', message: 'Session not found.' });
    }

    if (req.user.role === 'candidate' && session.user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Forbidden', message: 'Access denied.' });
    }

    const logs = db.prepare(`
      SELECT * FROM proctoring_logs WHERE session_id = ? ORDER BY timestamp ASC
    `).all(req.params.session_id);

    const parsed = logs.map(l => ({ ...l, payload: JSON.parse(l.payload || '{}') }));

    return res.json({ success: true, message: 'Logs fetched.', data: { logs: parsed, count: parsed.length } });
  } catch (err) {
    next(err);
  }
});

// ─── GET /summary/:session_id ─────────────────────────────────────────────────

router.get('/summary/:session_id', authenticate, (req, res, next) => {
  try {
    const session = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(req.params.session_id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'NotFound', message: 'Session not found.' });
    }
    if (req.user.role === 'candidate' && session.user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Forbidden', message: 'Access denied.' });
    }

    const byType = db.prepare(`
      SELECT event_type, COUNT(*) as count FROM proctoring_logs WHERE session_id = ? GROUP BY event_type
    `).all(req.params.session_id);

    const bySeverity = db.prepare(`
      SELECT severity, COUNT(*) as count FROM proctoring_logs WHERE session_id = ? GROUP BY severity
    `).all(req.params.session_id);

    const criticalEvents = db.prepare(`
      SELECT * FROM proctoring_logs WHERE session_id = ? AND severity = 'critical' ORDER BY timestamp ASC
    `).all(req.params.session_id);

    const aiAccesses = db.prepare(`
      SELECT * FROM proctoring_logs WHERE session_id = ? AND event_type IN ('ai_tool_access', 'question_leakage') ORDER BY timestamp ASC
    `).all(req.params.session_id);

    const trustData = calculateTrustScore(session.id);

    const summary = {
      total_events: byType.reduce((s, r) => s + r.count, 0),
      by_event_type: byType.reduce((acc, r) => { acc[r.event_type] = r.count; return acc; }, {}),
      by_severity: bySeverity.reduce((acc, r) => { acc[r.severity] = r.count; return acc; }, {}),
      critical_count: criticalEvents.length,
      critical_events: criticalEvents.map(l => ({ ...l, payload: JSON.parse(l.payload || '{}') })),
      ai_tool_accesses: aiAccesses.map(l => ({ ...l, payload: JSON.parse(l.payload || '{}') })),
      warning_count: session.warning_count,
      session_status: session.status,
      trust_score: trustData ? trustData.trust_score : 100,
      risk_level: trustData ? trustData.risk_level : 'LOW',
    };

    return res.json({ success: true, message: 'Summary generated.', data: { summary } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
