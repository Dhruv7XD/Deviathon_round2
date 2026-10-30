'use strict';

const db = require('../database');

// Common English stopwords to ignore in leakage detection
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'by', 'for',
  'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before',
  'after', 'above', 'below', 'to', 'from', 'up', 'down', 'of', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
  'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than',
  'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those'
]);

function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Detects if a search query, clipboard text, or prompt leaks content from an assessment question.
 * Uses Jaccard n-gram and keyword overlap.
 */
function detectQuestionLeakage(inputText, assessmentId) {
  if (!inputText || !assessmentId) {
    return { leakageDetected: false, similarityScore: 0, matchedQuestionId: null, matchedSnippet: null };
  }

  const inputTokens = new Set(tokenize(inputText));
  if (inputTokens.size === 0) {
    return { leakageDetected: false, similarityScore: 0, matchedQuestionId: null, matchedSnippet: null };
  }

  const questions = db.prepare('SELECT id, question_text FROM questions WHERE assessment_id = ?').all(assessmentId);

  let bestMatch = {
    leakageDetected: false,
    similarityScore: 0,
    matchedQuestionId: null,
    matchedSnippet: null,
  };

  for (const q of questions) {
    const qTokens = new Set(tokenize(q.question_text));
    if (qTokens.size === 0) continue;

    // Intersection
    let intersection = 0;
    for (const token of inputTokens) {
      if (qTokens.has(token)) {
        intersection++;
      }
    }

    // Jaccard similarity
    const union = new Set([...inputTokens, ...qTokens]).size;
    const similarity = union > 0 ? intersection / union : 0;

    // Substring containment check (for exact phrases of 3+ words)
    const cleanInput = inputText.toLowerCase().trim();
    const cleanQ = q.question_text.toLowerCase().trim();
    const containsPhrase = (cleanInput.length > 15 && cleanQ.includes(cleanInput)) ||
                           (cleanQ.length > 15 && cleanInput.includes(cleanQ));

    if (similarity > bestMatch.similarityScore || containsPhrase) {
      const finalScore = containsPhrase ? Math.max(similarity, 0.9) : Math.round(similarity * 100) / 100;
      if (finalScore >= 0.35 || containsPhrase) {
        bestMatch = {
          leakageDetected: true,
          similarityScore: finalScore,
          matchedQuestionId: q.id,
          matchedSnippet: q.question_text.length > 80 ? q.question_text.substring(0, 80) + '...' : q.question_text,
        };
      }
    }
  }

  return bestMatch;
}

/**
 * Analyzes keystroke timing and input bursts.
 * Detects paste masquerading as typing or automated macro injection.
 */
function detectKeystrokeAnomaly(payload) {
  if (!payload || typeof payload !== 'object') {
    return { anomalous: false, reason: null };
  }

  const { charCount = 0, durationMs = 0, wpm = 0 } = payload;

  // Superhuman speed: > 25 characters in under 100ms
  if (charCount > 25 && durationMs < 100) {
    return {
      anomalous: true,
      reason: 'Automated macro / rapid clipboard burst injection detected',
      confidence: 0.95,
      wpm: Math.round((charCount / 5) / (durationMs / 60000 || 0.001)),
    };
  }

  // Sustained impossible WPM (> 200 WPM)
  if (wpm > 200) {
    return {
      anomalous: true,
      reason: `Superhuman typing rate: ${wpm} WPM`,
      confidence: 0.88,
      wpm,
    };
  }

  return { anomalous: false, reason: null };
}

/**
 * Calculates real-time 0-100 Trust Score and Risk Level for a test session.
 */
function calculateTrustScore(sessionId) {
  const session = db.prepare('SELECT * FROM test_sessions WHERE id = ?').get(sessionId);
  if (!session) return null;

  const logs = db.prepare(`
    SELECT event_type, severity, payload, timestamp
    FROM proctoring_logs
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `).all(sessionId);

  let score = 100;
  const penalties = {
    ai_tool_access: 0,
    question_leakage: 0,
    tab_switch: 0,
    face_absent: 0,
    multiple_faces: 0,
    copy_paste: 0,
    keystroke_anomaly: 0,
    devtools_or_shortcut: 0,
    audio_anomaly: 0,
  };

  let tabSwitchCount = 0;

  for (const log of logs) {
    let payload = {};
    try { payload = JSON.parse(log.payload || '{}'); } catch { payload = {}; }

    switch (log.event_type) {
      case 'ai_tool_access':
        penalties.ai_tool_access += 30;
        break;

      case 'question_leakage':
        penalties.question_leakage += 35;
        break;

      case 'tab_switch':
        tabSwitchCount++;
        // 1 grace tab switch allowed for accidental clicks
        if (tabSwitchCount > 1) {
          penalties.tab_switch += 8;
        }
        break;

      case 'face_absent':
        const absentSec = (payload.duration_ms || 3000) / 1000;
        penalties.face_absent += absentSec > 5 ? 15 : 8;
        break;

      case 'multiple_faces':
        penalties.multiple_faces += 25;
        break;

      case 'copy_paste':
        penalties.copy_paste += 10;
        break;

      case 'keystroke_anomaly':
        penalties.keystroke_anomaly += 12;
        break;

      case 'right_click':
      case 'fullscreen_exit':
      case 'devtools_opened':
        penalties.devtools_or_shortcut += 15;
        break;

      case 'audio_anomaly':
        penalties.audio_anomaly += 10;
        break;

      default:
        break;
    }
  }

  const totalDeduction = Object.values(penalties).reduce((a, b) => a + b, 0);
  score = Math.max(0, 100 - totalDeduction);

  let riskLevel = 'LOW';
  if (score < 40) {
    riskLevel = 'CRITICAL';
  } else if (score < 65) {
    riskLevel = 'HIGH';
  } else if (score < 85) {
    riskLevel = 'MODERATE';
  }

  // Persist updated trust score in DB
  try {
    db.prepare(`
      UPDATE test_sessions
      SET trust_score = ?, risk_level = ?, updated_at = ?
      WHERE id = ?
    `).run(score, riskLevel, new Date().toISOString(), sessionId);
  } catch (err) {
    // If column doesn't exist yet, it's handled in database migration
  }

  return {
    trust_score: score,
    risk_level: riskLevel,
    penalties,
    total_deduction: totalDeduction,
    total_events_analyzed: logs.length,
  };
}

/**
 * Generates an executive Proctoring Integrity Audit Report.
 */
function generateAuditReport(sessionId) {
  const session = db.prepare(`
    SELECT s.*, a.title as assessment_title, a.duration_minutes, a.max_warnings,
           u.name as candidate_name, u.email as candidate_email
    FROM test_sessions s
    JOIN assessments a ON s.assessment_id = a.id
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
  `).get(sessionId);

  if (!session) return null;

  const trustData = calculateTrustScore(sessionId);
  const criticalLogs = db.prepare(`
    SELECT event_type, severity, payload, timestamp
    FROM proctoring_logs
    WHERE session_id = ? AND severity IN ('warning', 'critical')
    ORDER BY timestamp ASC
  `).all(sessionId);

  const formattedEvents = criticalLogs.map(l => {
    let p = {};
    try { p = JSON.parse(l.payload || '{}'); } catch { p = {}; }
    return {
      event_type: l.event_type,
      severity: l.severity,
      timestamp: l.timestamp,
      details: p,
    };
  });

  // Calculate component ratings (out of 100)
  const webcamIntegrity = Math.max(0, 100 - (trustData.penalties.face_absent + trustData.penalties.multiple_faces));
  const navigationIntegrity = Math.max(0, 100 - (trustData.penalties.tab_switch + trustData.penalties.devtools_or_shortcut));
  const aiSafetyIntegrity = Math.max(0, 100 - (trustData.penalties.ai_tool_access + trustData.penalties.question_leakage));
  const inputIntegrity = Math.max(0, 100 - (trustData.penalties.copy_paste + trustData.penalties.keystroke_anomaly));

  let verdict = 'VERIFIED_CLEAN';
  let recommendation = 'Approve assessment submission. No substantial breaches detected.';

  if (trustData.trust_score < 40 || session.status === 'disqualified') {
    verdict = 'COMPROMISED_DISQUALIFIED';
    recommendation = 'Reject assessment results due to critical integrity violations.';
  } else if (trustData.trust_score < 70 || formattedEvents.length >= 3) {
    verdict = 'FLAGGED_MANUAL_REVIEW';
    recommendation = 'Manual examiner review required. Irregular activity recorded.';
  }

  return {
    report_id: `REP-${sessionId.substring(0, 8).toUpperCase()}`,
    generated_at: new Date().toISOString(),
    session_id: sessionId,
    candidate: {
      name: session.candidate_name,
      email: session.candidate_email,
    },
    assessment: {
      title: session.assessment_title,
      duration_minutes: session.duration_minutes,
    },
    verdict,
    recommendation,
    trust_index: {
      overall_trust_score: trustData.trust_score,
      risk_level: trustData.risk_level,
      component_breakdown: {
        webcam_integrity: webcamIntegrity,
        navigation_integrity: navigationIntegrity,
        ai_tool_defense: aiSafetyIntegrity,
        input_integrity: inputIntegrity,
      },
      penalties: trustData.penalties,
    },
    session_outcome: {
      status: session.status,
      score: session.score,
      percentage: session.percentage,
      passed: !!session.passed,
      warning_count: session.warning_count,
      disqualification_reason: session.disqualification_reason,
    },
    critical_incident_timeline: formattedEvents,
  };
}

module.exports = {
  detectQuestionLeakage,
  detectKeystrokeAnomaly,
  calculateTrustScore,
  generateAuditReport,
};

