-- 023_flow_kind.sql
--
-- Wave 1 hardening. `proc.purchase_requisitions.scope` was doing double duty:
-- the light flow writes free business text into it ("Laptop", "sales",
-- "Demo PR - Cardboard restock") while the capital flow was identified by the
-- literal value 'CAPITAL_PR'. That works until a requester types "CAPITAL_PR"
-- into the scope field on a lightweight PR, at which point my-prs misfiles it
-- in the detailed table.
--
-- `flow_kind` is an explicit, closed discriminator. `scope` reverts to being
-- purely the business scope text it was always meant to be.

BEGIN;

ALTER TABLE proc.purchase_requisitions ADD COLUMN IF NOT EXISTS flow_kind text;

ALTER TABLE proc.purchase_requisitions DROP CONSTRAINT IF EXISTS pr_flow_kind_check;
ALTER TABLE proc.purchase_requisitions
  ADD CONSTRAINT pr_flow_kind_check
  CHECK (flow_kind IS NULL OR flow_kind IN ('CAPITAL', 'LIGHT'));

-- Backfill: anything carrying the 'CAPITAL_PR' scope sentinel is the capital
-- flow. Everything else that already has lines is a lightweight request.
UPDATE proc.purchase_requisitions
   SET flow_kind = 'CAPITAL'
 WHERE scope = 'CAPITAL_PR';

UPDATE proc.purchase_requisitions p
   SET flow_kind = 'LIGHT'
 WHERE p.flow_kind IS NULL
   AND EXISTS (SELECT 1 FROM proc.pr_lines l WHERE l.pr_id = p.id);

-- Anything still NULL is a PR with no lines at all; default it to LIGHT, which
-- is the flow the seed data belongs to.
UPDATE proc.purchase_requisitions
   SET flow_kind = 'LIGHT'
 WHERE flow_kind IS NULL;

CREATE INDEX IF NOT EXISTS idx_pr_flow_kind ON proc.purchase_requisitions(flow_kind);

COMMENT ON COLUMN proc.purchase_requisitions.flow_kind IS
  'Explicit PR flow discriminator: CAPITAL (legacy detailed requisition) or LIGHT (lightweight purchase request). NULL = not yet set. `scope` is free business text and must NOT be used for this.';
COMMENT ON COLUMN proc.purchase_requisitions.scope IS
  'Free-text business scope. NOT a flow discriminator — use flow_kind.';

COMMIT;
