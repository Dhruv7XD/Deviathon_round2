'use strict';

const { supabase, isSupabaseConfigured } = require('../supabase');

/**
 * Sync a new proctoring log to Supabase in the background.
 * This triggers Supabase Realtime websocket subscriptions on the Lovable frontend.
 */
async function syncLogToSupabase(logRecord) {
  if (!isSupabaseConfigured()) return;

  try {
    const { error } = await supabase
      .from('proctoring_logs')
      .insert({
        id: logRecord.id,
        session_id: logRecord.session_id,
        user_id: logRecord.user_id,
        event_type: logRecord.event_type,
        severity: logRecord.severity,
        payload: typeof logRecord.payload === 'string' ? JSON.parse(logRecord.payload) : logRecord.payload,
        created_at: logRecord.timestamp,
      });

    if (error) {
      console.warn('[SUPABASE_SYNC] Log sync notice:', error.message);
    }
  } catch (err) {
    // Non-blocking background sync error
    console.warn('[SUPABASE_SYNC] Error syncing log:', err.message);
  }
}

/**
 * Sync test session state change to Supabase.
 */
async function syncSessionToSupabase(sessionRecord) {
  if (!isSupabaseConfigured()) return;

  try {
    const { error } = await supabase
      .from('test_sessions')
      .upsert({
        id: sessionRecord.id,
        user_id: sessionRecord.user_id,
        assessment_id: sessionRecord.assessment_id,
        status: sessionRecord.status,
        warning_count: sessionRecord.warning_count,
        trust_score: sessionRecord.trust_score,
        risk_level: sessionRecord.risk_level,
        time_remaining_seconds: sessionRecord.time_remaining_seconds,
        is_paused: !!sessionRecord.is_paused,
        disqualification_reason: sessionRecord.disqualification_reason,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      console.warn('[SUPABASE_SYNC] Session sync notice:', error.message);
    }
  } catch (err) {
    console.warn('[SUPABASE_SYNC] Error syncing session:', err.message);
  }
}

/**
 * Sync proctor intervention to Supabase to trigger instant candidate alerts.
 */
async function syncInterventionToSupabase(interventionRecord) {
  if (!isSupabaseConfigured()) return;

  try {
    const { error } = await supabase
      .from('proctor_interventions')
      .insert({
        id: interventionRecord.id,
        session_id: interventionRecord.session_id,
        examiner_id: interventionRecord.examiner_id,
        action_type: interventionRecord.action_type,
        message: interventionRecord.message,
        created_at: interventionRecord.created_at,
      });

    if (error) {
      console.warn('[SUPABASE_SYNC] Intervention sync notice:', error.message);
    }
  } catch (err) {
    console.warn('[SUPABASE_SYNC] Error syncing intervention:', err.message);
  }
}

module.exports = {
  syncLogToSupabase,
  syncSessionToSupabase,
  syncInterventionToSupabase,
};

