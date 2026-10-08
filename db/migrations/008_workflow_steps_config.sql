-- 008_workflow_steps_config.sql
-- Phase: 1 — Foundation (foundation seed for the live workflow engine)
-- Purpose: workflow.steps_config mirrors STATE.workflow.steps in the prototype;
--          workflow.pr_workflow_snapshot captures per-PR step version.

BEGIN;

SET LOCAL search_path = workflow, proc, public;

-- Sequence used to seed order_index if absent
CREATE SEQUENCE IF NOT EXISTS workflow.step_order_seq START 1;

CREATE TABLE IF NOT EXISTS workflow.steps_config (
  id                   text PRIMARY KEY,                       -- step id, e.g. 'hod_review'
  payload              jsonb NOT NULL,                          -- full step object (name, actorRole, to, when, ...)
  order_index          int  NOT NULL,
  updated_by_user_id   uuid REFERENCES core.users(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              int  NOT NULL DEFAULT 1,
  CONSTRAINT steps_payload_object CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_steps_order ON workflow.steps_config(order_index);

CREATE TABLE IF NOT EXISTS workflow.pr_workflow_snapshot (
  pr_id                 uuid PRIMARY KEY REFERENCES proc.purchase_requisitions(id) ON DELETE CASCADE,
  steps                 jsonb NOT NULL,
  management_threshold  numeric(18,2) NOT NULL DEFAULT 1000000,
  snapshot_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pr_wf_steps_object CHECK (jsonb_typeof(steps) = 'array')
);

-- Seed the default step array (mirrors DEFAULT_WORKFLOW_STEPS in the prototype).
INSERT INTO workflow.steps_config (id, payload, order_index) VALUES
  ('rework',          jsonb_build_object('name','Sent back for rework','actorRole','requester','to','IN_PROCUREMENT_REVIEW','when','reworkRequested','canSkip',false,'requiresCapexOpex',false,'terminal',false,'branchOf','cost_center'), 1),
  ('reject',          jsonb_build_object('name','Rejected','actorRole','system','to','REJECTED','when','lineRejected','canSkip',false,'requiresCapexOpex',false,'terminal',true), 2),
  ('fulfilled_stock', jsonb_build_object('name','Fulfilled from stock','actorRole','system','to','FULFILLED_FROM_STOCK','when','inStock','canSkip',false,'requiresCapexOpex',false,'terminal',true), 3),
  ('out_of_stock',    jsonb_build_object('name','Out of stock (forward)','actorRole','procurement','to','IN_PROCUREMENT_REVIEW','when','outOfStock','canSkip',false,'requiresCapexOpex',false,'terminal',false), 4),
  ('warehouse_check', jsonb_build_object('name','Warehouse stock check','actorRole','store_incharge','to','IN_WAREHOUSE_CHECK','when','wantWarehouse','canSkip',true,'requiresCapexOpex',false,'terminal',false), 5),
  ('hod_review',      jsonb_build_object('name','Department review','actorRole','department_manager','to','IN_PROCUREMENT_REVIEW','when','always','canSkip',false,'requiresCapexOpex',false,'terminal',false), 6),
  ('procurement',     jsonb_build_object('name','Procurement review','actorRole','procurement','to','IN_COST_CENTER_APPROVAL','when','always','canSkip',false,'requiresCapexOpex',false,'terminal',false), 7),
  ('cost_center',     jsonb_build_object('name','Cost approval','actorRole','cost_center_owner','to','IN_FINANCE_REVIEW','when','always','canSkip',false,'requiresCapexOpex',false,'terminal',false), 8),
  ('finance_review',  jsonb_build_object('name','Finance review','actorRole','finance','to','IN_MANAGEMENT_REVIEW','when','amountGT','canSkip',true,'requiresCapexOpex',true,'terminal',false,'conditionValue',1000000), 9),
  ('finance_release', jsonb_build_object('name','Finance release','actorRole','finance','to','READY_FOR_D365','when','amountLTE','canSkip',false,'requiresCapexOpex',true,'terminal',false,'conditionValue',1000000), 10),
  ('management',      jsonb_build_object('name','Management gate','actorRole','management','to','READY_FOR_D365','when','always','canSkip',false,'requiresCapexOpex',false,'terminal',false), 11),
  ('d365_push',       jsonb_build_object('name','D365 push','actorRole','procurement','to','D365_PUSHED','when','always','canSkip',false,'requiresCapexOpex',false,'terminal',true), 12)
ON CONFLICT (id) DO NOTHING;

COMMIT;
