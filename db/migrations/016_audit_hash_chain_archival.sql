-- 016_audit_hash_chain_archival.sql
-- Phase: 6 — Launch (operational readiness)
-- Purpose: Hash-chain enablement for tamper-evidence; archival table for old audit rows.

BEGIN;

SET LOCAL search_path = audit, public;

-- ─── Hash chain function ───────────────────────────────────────────────────────
-- Each row stores a hash of the previous row's self_hash + canonical JSON of this row.
-- Computed lazily by a nightly job; the function is provided here for the job to call.

CREATE OR REPLACE FUNCTION audit.fn_compute_hash_chain(p_cutoff timestamptz DEFAULT now()) RETURNS void AS $$
DECLARE
  v_prev text;
  v_self text;
  r record;
BEGIN
  -- Start from the latest row that already has a hash, then walk forward.
  SELECT hash_chain_self INTO v_prev
  FROM audit.audit_log
  WHERE hash_chain_self IS NOT NULL
  ORDER BY id DESC
  LIMIT 1;

  IF v_prev IS NULL THEN
    -- Genesis row (no previous). Use a fixed salt; documented in runbook.
    v_prev := 'genesis:' || encode(digest('proc-portal-audit-genesis-2026-09-26', 'sha256'), 'hex');
  END IF;

  FOR r IN
    SELECT id, ts, actor_user_id, entity, entity_id, action, before, after, correlation_id
    FROM audit.audit_log
    WHERE hash_chain_self IS NULL
    ORDER BY id ASC
    LIMIT 10000
  LOOP
    v_self := 'sha256:' || encode(
      digest(
        v_prev || '|' ||
        r.id::text || '|' ||
        r.ts::text || '|' ||
        COALESCE(r.actor_user_id::text,'') || '|' ||
        r.entity || '|' ||
        r.entity_id || '|' ||
        r.action || '|' ||
        COALESCE(r.before::text,'') || '|' ||
        COALESCE(r.after::text,'') || '|' ||
        COALESCE(r.correlation_id,''),
        'sha256'
      ),
      'hex'
    );

    UPDATE audit.audit_log
       SET hash_chain_prev = v_prev,
           hash_chain_self = v_self
     WHERE id = r.id;

    v_prev := v_self;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ─── Archival table (cold storage mirror) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit.audit_log_archive (LIKE audit.audit_log INCLUDING ALL);
-- Archive rows keep the same structure but are NOT chained live; they retain
-- the frozen hash_chain_self from the live table at archival time.

CREATE INDEX IF NOT EXISTS idx_audit_archive_ts ON audit.audit_log_archive(ts DESC);

-- ─── Archive function (move rows > 7 years to cold) ─────────────────────────────
CREATE OR REPLACE FUNCTION audit.fn_archive_old_audit(p_cutoff date DEFAULT (current_date - interval '7 years'))
RETURNS int AS $$
DECLARE
  v_count int;
BEGIN
  WITH moved AS (
    DELETE FROM audit.audit_log
    WHERE ts < p_cutoff
    RETURNING *
  )
  INSERT INTO audit.audit_log_archive
  SELECT * FROM moved;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMIT;
