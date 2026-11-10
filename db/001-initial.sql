-- Conversations own student sessions. Store a token hash so a database read does not reveal session credentials.
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY, session_hash text NOT NULL UNIQUE,
  name text, email text, created_at timestamptz NOT NULL DEFAULT now()
);
-- A turn is a student message and its resulting assistant message, including persisted failures.
CREATE TABLE IF NOT EXISTS turns (
  id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id),
  request_id uuid NOT NULL, student_text text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','completed')),
  decision jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, UNIQUE(conversation_id, request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_turn ON turns(conversation_id) WHERE state = 'pending';
CREATE TABLE IF NOT EXISTS cases (
  id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id),
  category text NOT NULL, urgency text NOT NULL CHECK (urgency IN ('low','medium','high','critical')),
  safeguarding boolean NOT NULL, summary text NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','resolved')),
  claimed_by text, claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'new' AND claimed_by IS NULL) OR (status IN ('in_progress','resolved') AND claimed_by IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_case ON cases(conversation_id) WHERE status <> 'resolved';
