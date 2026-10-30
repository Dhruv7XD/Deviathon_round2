'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

let supabase = null;

if (supabaseUrl && supabaseKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    console.log('[SUPABASE] Initialized successfully with project:', supabaseUrl);
  } catch (err) {
    console.warn('[SUPABASE] Warning: Initialization failed:', err.message);
  }
} else {
  // Graceful fallback when env vars are pending configuration by user
  console.log('[SUPABASE] Info: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not yet configured in .env. Running in hybrid/local mode.');
}

module.exports = { supabase, isSupabaseConfigured: () => !!supabase };

