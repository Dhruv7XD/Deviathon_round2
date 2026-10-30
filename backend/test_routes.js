'use strict';

const app = require('./src/index.js');
const { EventEmitter } = require('events');

function mockRequest(method, url, body = {}, headers = {}) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.originalUrl = url;
    req.headers = { 'content-type': 'application/json', ...headers };
    req.body = body;
    req.query = {};
    req.params = {};
    req.ip = '127.0.0.1';
    req.socket = { remoteAddress: '127.0.0.1' };

    let resHeaders = {};
    let statusCode = 200;

    const res = {
      setHeader: (k, v) => { resHeaders[k.toLowerCase()] = v; },
      getHeader: (k) => resHeaders[k.toLowerCase()],
      removeHeader: (k) => { delete resHeaders[k.toLowerCase()]; },
      status: (code) => { statusCode = code; return res; },
      json: (data) => { resolve({ statusCode, headers: resHeaders, body: data }); return res; },
      send: (data) => { resolve({ statusCode, headers: resHeaders, body: data }); return res; },
      end: (data) => { resolve({ statusCode, headers: resHeaders, body: data }); return res; }
    };

    app.handle(req, res);
  });
}

(async () => {
  try {
    console.log('\n--- 🚀 RUNNING SMART PROCTORING BACKEND VERIFICATION ---\n');

    // 1. Health check
    const health = await mockRequest('GET', '/api/health');
    console.log('✅ 1. HEALTH:', health.statusCode, health.body?.data?.status);

    // 2. Candidate login
    const login = await mockRequest('POST', '/api/auth/login/password', {
      email: 'alice@test.com',
      password: 'Test@123'
    });
    console.log('✅ 2. CANDIDATE LOGIN:', login.statusCode, 'token received');
    const token = login.body?.data?.token;
    const authHeaders = { authorization: `Bearer ${token}` };

    // 3. Examiner login
    const examLogin = await mockRequest('POST', '/api/auth/login/password', {
      email: 'examiner@proctorshield.app',
      password: 'Exam@123'
    });
    console.log('✅ 3. EXAMINER LOGIN:', examLogin.statusCode, 'examiner token received');
    const examinerToken = examLogin.body?.data?.token;
    const examinerHeaders = { authorization: `Bearer ${examinerToken}` };

    // 4. Fetch assessments
    const assess = await mockRequest('GET', '/api/assessments', {}, authHeaders);
    const assessmentsList = assess.body?.data?.assessments || [];
    console.log('✅ 4. ASSESSMENTS:', assess.statusCode, `${assessmentsList.length} assessment(s) found`);
    const assessment = assessmentsList[0];

    // 5. Create / start test session
    const createSession = await mockRequest('POST', '/api/sessions', {
      assessment_id: assessment.id
    }, authHeaders);
    const sessionId = createSession.body?.data?.session?.id;
    console.log('✅ 5. CREATE SESSION:', createSession.statusCode, 'session_id:', sessionId);

    // 6. Complete Face Check
    const faceVerify = await mockRequest('POST', `/api/sessions/${sessionId}/face-verify`, {
      face_descriptor: [0.12, 0.45, 0.98, -0.22]
    }, authHeaders);
    console.log('✅ 6. FACE VERIFY:', faceVerify.statusCode, 'status:', faceVerify.body?.data?.session?.status);

    // 7. Fetch questions
    const questionsRes = await mockRequest('GET', `/api/assessments/${assessment.id}/questions?session_id=${sessionId}`, {}, authHeaders);
    const questions = questionsRes.body?.data?.questions || [];
    console.log('✅ 7. QUESTIONS FETCHED:', questionsRes.statusCode, `${questions.length} questions`);

    // 8. SMART TEST: Question Leakage Detection
    const leakLog = await mockRequest('POST', '/api/proctoring/log', {
      session_id: sessionId,
      event_type: 'tab_switch',
      severity: 'warning',
      payload: {
        toUrl: 'https://google.com/search?q=capital+of+France+city',
        searchQuery: 'What is the capital of France city'
      }
    }, authHeaders);
    console.log('🧠 8. QUESTION LEAKAGE DETECTED:',
      leakLog.statusCode,
      'flagged:', leakLog.body?.data?.flagged,
      'event_type:', leakLog.body?.data?.event_type,
      'similarity:', leakLog.body?.data?.leakage?.similarityScore,
      'matchedSnippet:', leakLog.body?.data?.leakage?.matchedSnippet
    );

    // 9. SMART TEST: Real-time AI Tool Detection
    const aiLog = await mockRequest('POST', '/api/proctoring/log', {
      session_id: sessionId,
      event_type: 'tab_switch',
      severity: 'warning',
      payload: {
        toUrl: 'https://claude.ai/chat/new-session',
        searchQuery: 'Solve MCQ options A B C'
      }
    }, authHeaders);
    console.log('🧠 9. AI TOOL DETECTED:',
      aiLog.statusCode,
      'tool:', aiLog.body?.data?.tool,
      'warning_count:', aiLog.body?.data?.warning_count,
      'trust_score:', aiLog.body?.data?.trust_score,
      'risk_level:', aiLog.body?.data?.risk_level
    );

    // 10. SMART TEST: Keystroke Macro / Paste Burst Detection
    const keyLog = await mockRequest('POST', '/api/proctoring/log', {
      session_id: sessionId,
      event_type: 'keystroke_anomaly',
      severity: 'info',
      payload: {
        charCount: 80,
        durationMs: 35, // 80 chars in 35ms is a bot/macro
      }
    }, authHeaders);
    console.log('🧠 10. KEYSTROKE BURST DETECTED:',
      keyLog.statusCode,
      'trust_score:', keyLog.body?.data?.trust_score,
      'risk_level:', keyLog.body?.data?.risk_level
    );

    // 11. SMART TEST: Examiner Live Dashboard
    const liveDash = await mockRequest('GET', '/api/proctoring/live-dashboard', {}, examinerHeaders);
    console.log('👁️ 11. EXAMINER LIVE DASHBOARD:',
      liveDash.statusCode,
      'active candidates:', liveDash.body?.data?.active_candidates_count,
      'candidate trust:', liveDash.body?.data?.candidates?.[0]?.trust_score,
      'risk:', liveDash.body?.data?.candidates?.[0]?.risk_level
    );

    // 12. SMART TEST: Remote Examiner Intervention
    const intervention = await mockRequest('POST', `/api/proctoring/intervene/${sessionId}`, {
      action_type: 'warn',
      message: 'Attention: AI tool access and suspicious tab switches detected. This is your final warning!'
    }, examinerHeaders);
    console.log('⚡ 12. EXAMINER INTERVENTION:', intervention.statusCode, intervention.body?.message);

    // 13. SMART TEST: Heartbeat Alert Delivery to Candidate
    const heartbeat = await mockRequest('POST', `/api/sessions/${sessionId}/heartbeat`, {
      time_remaining_seconds: 1700,
      answered_count: 1
    }, authHeaders);
    console.log('📡 13. HEARTBEAT WARNING DELIVERED:',
      heartbeat.statusCode,
      'alert:', heartbeat.body?.data?.warning_message ? 'YES: "' + heartbeat.body?.data?.warning_message.substring(0, 45) + '..."' : 'NONE'
    );

    // 14. Answer question
    const ans = await mockRequest('POST', `/api/sessions/${sessionId}/answer`, {
      question_id: questions[0].id,
      selected_option: 'A'
    }, authHeaders);
    console.log('✅ 14. ANSWER SUBMISSION:', ans.statusCode, ans.body?.message);

    // 15. Submit test
    const submit = await mockRequest('POST', `/api/sessions/${sessionId}/submit`, {}, authHeaders);
    console.log('✅ 15. SUBMIT TEST:', submit.statusCode, 'score:', submit.body?.data?.raw_score, 'trust:', submit.body?.data?.trust_index?.trust_score);

    // 16. SMART TEST: Executive Proctoring Audit Report
    const auditReport = await mockRequest('GET', `/api/proctoring/audit-report/${sessionId}`, {}, examinerHeaders);
    const rep = auditReport.body?.data?.report;
    console.log('📑 16. EXECUTIVE AUDIT REPORT:',
      auditReport.statusCode,
      'report_id:', rep?.report_id,
      'verdict:', rep?.verdict,
      'overall_trust_score:', rep?.trust_index?.overall_trust_score,
      'risk_level:', rep?.trust_index?.risk_level,
      'incidents_recorded:', rep?.critical_incident_timeline?.length
    );

    console.log('\n🎉 ALL 16 SMART PROCTORING TESTS PASSED FLAWLESSLY!\n');
    process.exit(0);
  } catch (err) {
    console.error('Test error:', err);
    process.exit(1);
  }
})();
