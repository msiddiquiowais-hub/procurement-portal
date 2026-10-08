-- 012_proc_pack_d365.sql
-- Phase: 3 — Pack + Workflow Config
-- Purpose: approved_packs (immutable), d365_pushes (idempotent), d365_sync_log.

BEGIN;

SET LOCAL search_path = proc, core, public;

-- ─── Approved packs (immutable after frozen_at) ───────────────────────────────
CREATE TABLE IF NOT EXISTS proc.approved_packs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id                uuid NOT NULL UNIQUE REFERENCES proc.purchase_requisitions(id),
  pack_hash            text NOT NULL,
  payload              jsonb NOT NULL,                                       -- full pack snapshot
  frozen_at            timestamptz NOT NULL DEFAULT now(),
  frozen_by_user_id    uuid NOT NULL REFERENCES core.users(id),
  CONSTRAINT pack_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

-- Immutability trigger
CREATE OR REPLACE FUNCTION proc.fn_reject_pack_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'approved_packs is immutable (frozen_at = %)', OLD.frozen_at
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_approved_packs_no_update ON proc.approved_packs;
CREATE TRIGGER trg_approved_packs_no_update
BEFORE UPDATE ON proc.approved_packs
FOR EACH ROW EXECUTE FUNCTION proc.fn_reject_pack_mutation();

DROP TRIGGER IF EXISTS trg_approved_packs_no_delete ON proc.approved_packs;
CREATE TRIGGER trg_approved_packs_no_delete
BEFORE DELETE ON proc.approved_packs
FOR EACH ROW EXECUTE FUNCTION proc.fn_reject_pack_mutation();

-- ─── D365 pushes (idempotency key = portal_pr.id) ─────────────────────────────
CREATE TABLE IF NOT EXISTS proc.d365_pushes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id               uuid NOT NULL REFERENCES proc.purchase_requisitions(id),
  pack_id             uuid REFERENCES proc.approved_packs(id),
  idempotency_key     text UNIQUE NOT NULL,
  attempt_no          int  NOT NULL CHECK (attempt_no BETWEEN 1 AND 5),
  status              text NOT NULL
                        CHECK (status IN ('pending','succeeded','failed','dead_letter')),
  d365_po_number      text,
  d365_request_id     text,
  d365_response       jsonb,
  last_error          text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_pushes_pr_status   ON proc.d365_pushes(pr_id, status);
CREATE INDEX IF NOT EXISTS idx_pushes_started_at  ON proc.d365_pushes(started_at DESC);

-- ─── D365 sync log (read-back from poll/webhook/reconciliation) ───────────────
CREATE TABLE IF NOT EXISTS proc.d365_sync_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id        uuid NOT NULL REFERENCES proc.purchase_requisitions(id),
  d365_status  text NOT NULL,
  source       text NOT NULL CHECK (source IN ('poll','webhook','reconciliation')),
  raw          jsonb,
  observed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_d365_sync_pr ON proc.d365_sync_log(pr_id, observed_at DESC);

-- ─── Pack freeze helper: returns the canonical pack_hash for a given payload ──
-- Uses Postgres built-in sha256() on the canonical JSON representation.
CREATE OR REPLACE FUNCTION proc.fn_pack_hash(p_payload jsonb) RETURNS text AS $$
BEGIN
  RETURN 'sha256:' || encode(digest(p_payload::text, 'sha256'), 'hex');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMIT;
