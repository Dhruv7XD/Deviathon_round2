'use strict';

/**
 * Calculate the score for a test session.
 *
 * @param {object} session - The test_session row (answers as parsed object)
 * @param {Array}  questions - Array of question rows from the DB
 * @returns {{ raw_score: number, max_score: number, percentage: number, passed: boolean }}
 */
function calculateScore(session, questions) {
  const answers = typeof session.answers === 'string'
    ? JSON.parse(session.answers)
    : (session.answers || {});

  let raw_score = 0;
  let max_score = 0;

  for (const q of questions) {
    max_score += q.marks;
    const selected = answers[q.id];
    if (!selected) {
      // Unanswered — no change
      continue;
    }
    if (selected.toUpperCase() === q.correct_option.toUpperCase()) {
      raw_score += q.marks;
    } else {
      raw_score -= q.negative_marks;
    }
  }

  // Clamp raw score to 0 minimum
  if (raw_score < 0) raw_score = 0;

  const percentage = max_score > 0 ? (raw_score / max_score) * 100 : 0;

  return {
    raw_score,
    max_score,
    percentage: Math.round(percentage * 100) / 100,
    passed: false, // caller should compare against assessment.passing_score
  };
}

module.exports = { calculateScore };
