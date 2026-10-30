-- ============================================================================
-- SMART PROCTORING BROWSER FOR ASSESSMENT — SUPABASE DATABASE SCHEMA
-- Run this in your Supabase SQL Editor (Dashboard -> SQL Editor -> New Query)
-- ============================================================================

-- 1. Enable UUID Extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Profiles Table (extends auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'candidate' CHECK (role IN ('candidate', 'examiner', 'admin')),
  face_enrolled BOOLEAN NOT NULL DEFAULT false,
  face_descriptor JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Assessments Table
CREATE TABLE IF NOT EXISTS public.assessments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  description TEXT,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  max_warnings INTEGER NOT NULL DEFAULT 3,
  passing_score INTEGER NOT NULL DEFAULT 60,
  randomize_questions BOOLEAN NOT NULL DEFAULT true,
  allow_back_navigation BOOLEAN NOT NULL DEFAULT false,
  is_published BOOLEAN NOT NULL DEFAULT true,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Questions Table
CREATE TABLE IF NOT EXISTS public.questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  assessment_id UUID NOT NULL REFERENCES public.assessments(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  correct_option TEXT NOT NULL CHECK (correct_option IN ('A', 'B', 'C', 'D')),
  explanation TEXT,
  marks INTEGER NOT NULL DEFAULT 1,
  negative_marks REAL NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Test Sessions Table
CREATE TABLE IF NOT EXISTS public.test_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assessment_id UUID NOT NULL REFERENCES public.assessments(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'face_check', 'active', 'paused', 'submitted', 'timed_out', 'disqualified')),
  started_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  time_remaining_seconds INTEGER,
  warning_count INTEGER NOT NULL DEFAULT 0,
  trust_score REAL NOT NULL DEFAULT 100,
  risk_level TEXT NOT NULL DEFAULT 'LOW' CHECK (risk_level IN ('LOW', 'MODERATE', 'HIGH', 'CRITICAL')),
  is_paused BOOLEAN NOT NULL DEFAULT false,
  disqualification_reason TEXT,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  score REAL,
  percentage REAL,
  passed BOOLEAN,
  face_verified BOOLEAN NOT NULL DEFAULT false,
  proctoring_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Proctoring Logs Table (High frequency telemetry)
CREATE TABLE IF NOT EXISTS public.proctoring_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES public.test_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Proctor Interventions Table
CREATE TABLE IF NOT EXISTS public.proctor_interventions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES public.test_sessions(id) ON DELETE CASCADE,
  examiner_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('warn', 'pause', 'resume', 'disqualify', 'request_360_scan')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- REALTIME PUBLICATION SETUP
-- ============================================================================
-- Enable Supabase Realtime for live proctor supervision & instant alerts
ALTER PUBLICATION supabase_realtime ADD TABLE public.test_sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.proctoring_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.proctor_interventions;

-- Set replica identity to full so update events receive old and new row values
ALTER TABLE public.test_sessions REPLICA IDENTITY FULL;
ALTER TABLE public.proctoring_logs REPLICA IDENTITY FULL;
ALTER TABLE public.proctor_interventions REPLICA IDENTITY FULL;

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proctoring_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proctor_interventions ENABLE ROW LEVEL SECURITY;

-- Profiles: Anyone authenticated can read their profile; users can update own profile
CREATE POLICY "Profiles viewable by authenticated users"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id);

-- Assessments: Candidates view published; Examiners manage their own
CREATE POLICY "Candidates can read published assessments"
  ON public.assessments FOR SELECT
  TO authenticated
  USING (is_published = true OR created_by = auth.uid());

CREATE POLICY "Examiners can create assessments"
  ON public.assessments FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Examiners can update own assessments"
  ON public.assessments FOR UPDATE
  TO authenticated
  USING (auth.uid() = created_by);

-- Questions: Candidates see questions for active sessions (correct_option hidden via API)
CREATE POLICY "Authenticated users can read questions"
  ON public.questions FOR SELECT
  TO authenticated
  USING (true);

-- Test Sessions: Candidates can manage own sessions; Examiners can read all
CREATE POLICY "Candidates can view own test sessions"
  ON public.test_sessions FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('examiner', 'admin')
  ));

CREATE POLICY "Candidates can create test sessions"
  ON public.test_sessions FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Candidates and examiners can update sessions"
  ON public.test_sessions FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid() OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('examiner', 'admin')
  ));

-- Proctoring Logs: Candidates log telemetry; Examiners read telemetry
CREATE POLICY "Candidates can insert proctoring logs"
  ON public.proctoring_logs FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "View proctoring logs"
  ON public.proctoring_logs FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('examiner', 'admin')
  ));

-- Proctor Interventions: Examiners insert interventions; Candidates read for their session
CREATE POLICY "Examiners can insert interventions"
  ON public.proctor_interventions FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('examiner', 'admin')
  ));

CREATE POLICY "Candidates can view their interventions"
  ON public.proctor_interventions FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.test_sessions WHERE id = session_id AND user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('examiner', 'admin')
  ));

-- ============================================================================
-- AUTO PROFILE TRIGGER ON SIGNUP
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, name, email, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.raw_user_meta_data->>'full_name', SPLIT_PART(NEW.email, '@', 1)),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'role', 'candidate')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- SEED SAMPLE ASSESSMENT AND QUESTIONS
-- ============================================================================
DO $$
DECLARE
  v_assessment_id UUID := 'cb2c4a6f-3fdc-4e4e-badb-8fa4541ba692';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.assessments WHERE id = v_assessment_id) THEN
    INSERT INTO public.assessments (id, title, description, duration_minutes, max_warnings, passing_score, randomize_questions, is_published)
    VALUES (
      v_assessment_id,
      'General Knowledge & Aptitude Assessment',
      'Demonstration proctored test with real-time AI and browser anomaly detection.',
      30,
      3,
      60,
      true,
      true
    );

    INSERT INTO public.questions (assessment_id, question_text, option_a, option_b, option_c, option_d, correct_option, marks, negative_marks, order_index)
    VALUES
      (v_assessment_id, 'What is the capital of France?', 'Paris', 'London', 'Berlin', 'Madrid', 'A', 1, 0, 1),
      (v_assessment_id, 'What does HTTP stand for in web communication?', 'HyperText Transfer Protocol', 'High Transfer Text Protocol', 'Hyper Terminal Transfer Protocol', 'HyperText Transmission Port', 'A', 1, 0, 2),
      (v_assessment_id, 'Which planet is known as the Red Planet in our solar system?', 'Venus', 'Jupiter', 'Mars', 'Saturn', 'C', 1, 0, 3),
      (v_assessment_id, 'What is 15% of 200?', '25', '30', '35', '40', 'B', 1, 0, 4),
      (v_assessment_id, 'Who wrote the tragedy play Romeo and Juliet?', 'Charles Dickens', 'William Shakespeare', 'Mark Twain', 'Jane Austen', 'B', 1, 0, 5);
  END IF;
END $$;

