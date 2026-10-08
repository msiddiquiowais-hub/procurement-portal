-- 005_notifications.sql
-- Phase: 1 — Foundation
-- Purpose: Notifications + templates + outbox (reliable delivery via BullMQ).

BEGIN;

SET LOCAL search_path = core, public;

CREATE TABLE IF NOT EXISTS core.notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES core.users(id),
  kind            text NOT NULL,                              -- e.g. 'PR_SUBMITTED', 'HOD_APPROVED'
  entity          text,
  entity_id       text,
  title           text NOT NULL,
  body            text,
  channels_sent   text[] NOT NULL DEFAULT '{}',               -- {email,bell,whatsapp}
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  correlation_id  text
);
CREATE INDEX IF NOT EXISTS idx_notif_user_unread ON core.notifications(user_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notif_user_all    ON core.notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS core.notification_templates (
  key               text PRIMARY KEY,
  channel           text NOT NULL CHECK (channel IN ('email','bell','whatsapp')),
  subject_template  text,
  body_template     text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Outbox: queued → sent / failed / suppressed. Workers consume this table.
CREATE TABLE IF NOT EXISTS core.notification_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES core.notifications(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('email','bell','whatsapp')),
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sent','failed','suppressed')),
  attempts        int  NOT NULL DEFAULT 0,
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON core.notification_outbox(status, created_at)
  WHERE status = 'queued';

COMMIT;
