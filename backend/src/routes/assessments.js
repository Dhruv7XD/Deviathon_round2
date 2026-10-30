'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, param, validationResult } = require('express-validator');

const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');

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

// ─── GET / — list published assessments (public for candidates) ───────────────

router.get('/', authenticate, (req, res, next) => {
  try {
    let rows;
    if (req.user.role === 'candidate') {
      rows = db.prepare(`
        SELECT a.*, u.name as created_by_name
        FROM assessments a
        JOIN users u ON a.created_by = u.id
        WHERE a.is_published = 1
        ORDER BY a.created_at DESC
      `).all();
    } else {
      // examiner/admin sees all
      rows = db.prepare(`
        SELECT a.*, u.name as created_by_name
        FROM assessments a
        JOIN users u ON a.created_by = u.id
        ORDER BY a.created_at DESC
      `).all();
    }
    return res.json({ success: true, message: 'Assessments fetched.', data: { assessments: rows } });
  } catch (err) {
    next(err);
  }
});

// ─── GET /:id — get assessment metadata (no questions) ────────────────────────

router.get('/:id', authenticate, (req, res, next) => {
  try {
    const row = db.prepare(`
      SELECT a.*, u.name as created_by_name
      FROM assessments a
      JOIN users u ON a.created_by = u.id
      WHERE a.id = ?
    `).get(req.params.id);

    if (!row) {
      return res.status(404).json({ success: false, error: 'NotFound', message: 'Assessment not found.' });
    }

    if (req.user.role === 'candidate' && !row.is_published) {
      return res.status(403).json({ success: false, error: 'Forbidden', message: 'Assessment is not published.' });
    }

    return res.json({ success: true, message: 'Assessment fetched.', data: { assessment: row } });
  } catch (err) {
    next(err);
  }
});

// ─── POST / — create assessment (examiner/admin) ──────────────────────────────

router.post(
  '/',
  authenticate,
  requireRole('examiner', 'admin'),
  [
    body('title').trim().notEmpty().withMessage('Title is required.'),
    body('duration_minutes').isInt({ min: 1 }).withMessage('duration_minutes must be a positive integer.'),
    body('max_warnings').optional().isInt({ min: 1 }),
    body('passing_score').optional().isInt({ min: 0, max: 100 }),
    body('randomize_questions').optional().isBoolean(),
    body('allow_back_navigation').optional().isBoolean(),
    body('is_published').optional().isBoolean(),
  ],
  (req, res, next) => {
    try {
      const err = validationErrors(req, res);
      if (err) return;

      const {
        title, description, duration_minutes,
        max_warnings = 3, passing_score = 60,
        randomize_questions = true, allow_back_navigation = false,
        is_published = false, starts_at = null, ends_at = null,
      } = req.body;

      const id = uuidv4();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO assessments (id, title, description, created_by, duration_minutes, max_warnings, passing_score, randomize_questions, allow_back_navigation, is_published, starts_at, ends_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, title, description || null, req.user.id, duration_minutes,
        max_warnings, passing_score,
        randomize_questions ? 1 : 0, allow_back_navigation ? 1 : 0,
        is_published ? 1 : 0, starts_at, ends_at, now, now
      );

      const assessment = db.prepare('SELECT * FROM assessments WHERE id = ?').get(id);
      return res.status(201).json({ success: true, message: 'Assessment created.', data: { assessment } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /:id — update assessment (examiner/admin) ───────────────────────────

router.put(
  '/:id',
  authenticate,
  requireRole('examiner', 'admin'),
  (req, res, next) => {
    try {
      const assessment = db.prepare('SELECT * FROM assessments WHERE id = ?').get(req.params.id);
      if (!assessment) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'Assessment not found.' });
      }
      // Examiners can only update their own assessments
      if (req.user.role === 'examiner' && assessment.created_by !== req.user.id) {
        return res.status(403).json({ success: false, error: 'Forbidden', message: 'You can only update your own assessments.' });
      }

      const allowed = ['title','description','duration_minutes','max_warnings','passing_score','randomize_questions','allow_back_navigation','is_published','starts_at','ends_at'];
      const updates = [];
      const values = [];

      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates.push(`${key} = ?`);
          let val = req.body[key];
          if (typeof val === 'boolean') val = val ? 1 : 0;
          values.push(val);
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, error: 'NoUpdates', message: 'No valid fields to update.' });
      }

      const now = new Date().toISOString();
      updates.push('updated_at = ?');
      values.push(now);
      values.push(req.params.id);

      db.prepare(`UPDATE assessments SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      const updated = db.prepare('SELECT * FROM assessments WHERE id = ?').get(req.params.id);
      return res.json({ success: true, message: 'Assessment updated.', data: { assessment: updated } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /:id — delete assessment (admin only) ────────────────────────────

router.delete(
  '/:id',
  authenticate,
  requireRole('admin'),
  (req, res, next) => {
    try {
      const assessment = db.prepare('SELECT id FROM assessments WHERE id = ?').get(req.params.id);
      if (!assessment) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'Assessment not found.' });
      }
      db.prepare('DELETE FROM assessments WHERE id = ?').run(req.params.id);
      return res.json({ success: true, message: 'Assessment deleted.' });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:id/questions ───────────────────────────────────────────────────────

router.get('/:id/questions', authenticate, (req, res, next) => {
  try {
    const assessment = db.prepare('SELECT * FROM assessments WHERE id = ?').get(req.params.id);
    if (!assessment) {
      return res.status(404).json({ success: false, error: 'NotFound', message: 'Assessment not found.' });
    }

    let questions = db.prepare(`
      SELECT id, assessment_id, question_text, option_a, option_b, option_c, option_d,
             marks, negative_marks, order_index
      FROM questions WHERE assessment_id = ? ORDER BY order_index ASC
    `).all(req.params.id);

    // If candidate with active session, shuffle deterministically by session id
    if (req.user.role === 'candidate' && assessment.randomize_questions) {
      // Look for an active session
      const session = db.prepare(`
        SELECT id FROM test_sessions
        WHERE user_id = ? AND assessment_id = ? AND status IN ('active', 'face_check', 'pending')
        ORDER BY created_at DESC LIMIT 1
      `).get(req.user.id, req.params.id);

      if (session) {
        // Seeded deterministic shuffle using session id as seed
        questions = seededShuffle(questions, session.id);
      }
    } else if (req.user.role !== 'candidate') {
      // Examiners/admins see correct_option too
      questions = db.prepare(`
        SELECT * FROM questions WHERE assessment_id = ? ORDER BY order_index ASC
      `).all(req.params.id);
    }

    return res.json({ success: true, message: 'Questions fetched.', data: { questions } });
  } catch (err) {
    next(err);
  }
});

/** Deterministic Fisher-Yates shuffle seeded by a string */
function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = [...seed].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  function rand() {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  }
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── POST /:id/questions — add a question (examiner/admin) ───────────────────

router.post(
  '/:id/questions',
  authenticate,
  requireRole('examiner', 'admin'),
  [
    body('question_text').trim().notEmpty().withMessage('question_text is required.'),
    body('option_a').trim().notEmpty().withMessage('option_a is required.'),
    body('option_b').trim().notEmpty().withMessage('option_b is required.'),
    body('option_c').trim().notEmpty().withMessage('option_c is required.'),
    body('option_d').trim().notEmpty().withMessage('option_d is required.'),
    body('correct_option').isIn(['A','B','C','D']).withMessage('correct_option must be A, B, C, or D.'),
  ],
  (req, res, next) => {
    try {
      const err = validationErrors(req, res);
      if (err) return;

      const assessment = db.prepare('SELECT * FROM assessments WHERE id = ?').get(req.params.id);
      if (!assessment) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'Assessment not found.' });
      }
      if (req.user.role === 'examiner' && assessment.created_by !== req.user.id) {
        return res.status(403).json({ success: false, error: 'Forbidden', message: 'You can only modify your own assessments.' });
      }

      const { question_text, option_a, option_b, option_c, option_d, correct_option, explanation, marks = 1, negative_marks = 0, order_index = 0 } = req.body;

      const id = uuidv4();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO questions (id, assessment_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation, marks, negative_marks, order_index, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, req.params.id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation || null, marks, negative_marks, order_index, now);

      const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
      return res.status(201).json({ success: true, message: 'Question added.', data: { question } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PUT /:id/questions/:qid ──────────────────────────────────────────────────

router.put(
  '/:id/questions/:qid',
  authenticate,
  requireRole('examiner', 'admin'),
  (req, res, next) => {
    try {
      const assessment = db.prepare('SELECT * FROM assessments WHERE id = ?').get(req.params.id);
      if (!assessment) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'Assessment not found.' });
      }
      if (req.user.role === 'examiner' && assessment.created_by !== req.user.id) {
        return res.status(403).json({ success: false, error: 'Forbidden', message: 'You can only modify your own assessments.' });
      }

      const question = db.prepare('SELECT * FROM questions WHERE id = ? AND assessment_id = ?').get(req.params.qid, req.params.id);
      if (!question) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'Question not found.' });
      }

      const allowed = ['question_text','option_a','option_b','option_c','option_d','correct_option','explanation','marks','negative_marks','order_index'];
      const updates = [];
      const values = [];

      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates.push(`${key} = ?`);
          values.push(req.body[key]);
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, error: 'NoUpdates', message: 'No valid fields to update.' });
      }

      values.push(req.params.qid);
      db.prepare(`UPDATE questions SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const updated = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.qid);
      return res.json({ success: true, message: 'Question updated.', data: { question: updated } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /:id/questions/:qid ───────────────────────────────────────────────

router.delete(
  '/:id/questions/:qid',
  authenticate,
  requireRole('examiner', 'admin'),
  (req, res, next) => {
    try {
      const assessment = db.prepare('SELECT * FROM assessments WHERE id = ?').get(req.params.id);
      if (!assessment) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'Assessment not found.' });
      }
      if (req.user.role === 'examiner' && assessment.created_by !== req.user.id) {
        return res.status(403).json({ success: false, error: 'Forbidden', message: 'You can only modify your own assessments.' });
      }

      const question = db.prepare('SELECT id FROM questions WHERE id = ? AND assessment_id = ?').get(req.params.qid, req.params.id);
      if (!question) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'Question not found.' });
      }

      db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.qid);
      return res.json({ success: true, message: 'Question deleted.' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
