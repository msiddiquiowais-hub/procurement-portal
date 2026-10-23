// Loading and saving the live routing configuration.
//
// This is the ONLY place in the API that touches workflow.steps_config. The
// engine never sees SQL; the API never sees a routing decision. Keeping the
// boundary here is what makes the Part 7 control panel real rather than
// decorative — a write through this repository changes what the next
// planAdvance() call computes.

import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';
import {
  DEFAULT_GOVERNANCE_STEPS,
  DEFAULT_MANAGEMENT_THRESHOLD,
  DEFAULT_WORKFLOW_STEPS,
  stepsFromConfigRows,
  stepToPayload,
  type WorkflowConfig,
} from '@procurement/workflow-engine';
import type { Step } from '@procurement/workflow-engine';

type StepRow = { id: string; payload: string; order_index: number; version: number };

@Injectable()
export class WorkflowRepository {
  private readonly log = new Logger(WorkflowRepository.name);

  constructor(private readonly db: DbService) {}

  /**
   * Read the whole routing table plus the management threshold.
   *
   * Falls back to the canonical defaults ONLY when the table is genuinely
   * unusable (missing, empty, or unreadable). A configured-but-unreadable table
   * is logged loudly rather than silently swapped for defaults, because silent
   * fallback is how a routing change "reverts by itself" and nobody notices for
   * a week.
   */
  async loadLive(): Promise<WorkflowConfig> {
    let rows: StepRow[] = [];
    let threshold = DEFAULT_MANAGEMENT_THRESHOLD;
    let degraded = false;

    try {
      const stepsRes = await this.db.query<StepRow>(
        `SELECT id, payload::text AS payload, order_index, version
           FROM workflow.steps_config
          ORDER BY order_index ASC`,
        [],
        { bypassRls: true },
      );
      rows = stepsRes.rows;

      const cfgRes = await this.db.query<{ value: string }>(
        `SELECT value::text AS value
           FROM workflow.config
          WHERE key = 'management_threshold'`,
        [],
        { bypassRls: true },
      );
      const raw = cfgRes.rows[0]?.value;
      if (raw !== undefined && raw !== null) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) threshold = n;
      }
    } catch (err) {
      degraded = true;
      this.log.error(
        `Failed to read workflow.steps_config; routing falls back to canonical defaults. ` +
          `A fallback here means admin changes are NOT taking effect. Cause: ${
            (err as Error).message
          }`,
      );
    }

    if (degraded) {
      return this.fallbackConfig('steps_config unreadable');
    }
    if (rows.length === 0) {
      this.log.warn('workflow.steps_config is EMPTY; routing falls back to canonical defaults.');
      return this.fallbackConfig('steps_config empty');
    }

    return {
      steps: stepsFromConfigRows(
        rows.map(r => ({ id: r.id, payload: this.parsePayload(r.payload, r.id), order_index: r.order_index })),
      ),
      managementThreshold: threshold,
      source: 'db',
      version: rows.reduce((max, r) => Math.max(max, Number(r.version) || 0), 0),
    };
  }

  /**
   * Read the configuration a PR was snapshotted with.
   *
   * Returns null when the PR has no snapshot, which means it predates this
   * feature (or was created while the table was unreadable) and should route on
   * the live table instead of refusing to move.
   */
  async loadForPr(prId: string): Promise<WorkflowConfig | null> {
    try {
      const r = await this.db.query<{ steps: string; management_threshold: string }>(
        `SELECT steps::text AS steps, management_threshold::text AS management_threshold
           FROM workflow.pr_workflow_snapshot
          WHERE pr_id = '${this.escapeUuid(prId)}'`,
        [],
        { bypassRls: true },
      );
      const row = r.rows[0];
      if (!row) return null;
      const parsed = this.parsePayload(row.steps, 'pr_workflow_snapshot');
      if (!Array.isArray(parsed)) {
        this.log.warn(`Snapshot for PR ${prId} is not an array; falling back to live config.`);
        return null;
      }
      const threshold = Number(row.management_threshold);
      return {
        steps: stepsFromConfigRows(
          (parsed as Array<Record<string, unknown>>).map((p, i) => ({
            id: String(p.key ?? `step_${i}`),
            payload: p,
            order_index: i + 1,
          })),
        ),
        managementThreshold: Number.isFinite(threshold) ? threshold : DEFAULT_MANAGEMENT_THRESHOLD,
        source: 'snapshot',
      };
    } catch (err) {
      this.log.warn(
        `Could not read workflow snapshot for PR ${prId} (${(err as Error).message}); ` +
          `routing on live config instead.`,
      );
      return null;
    }
  }

  /**
   * Add ONE named step to a PR's frozen snapshot, if it is not already there.
   *
   * WHY THIS EXISTS, AND WHY IT IS NOT A LOOPHOLE IN THE SNAPSHOT
   * -----------------------------------------------------------
   * A snapshot exists so an ADMIN EDIT cannot retroactively re-route a request
   * already in flight — moving the finance threshold after someone approved
   * against the old rule, deleting a stage, rewiring a transition. Every one of
   * those is a decision somebody took and may have relied on.
   *
   * A NEWLY SHIPPED CAPABILITY is not that. Nobody relied on `revert_to_hod`
   * being absent from a PR created last month; the step did not exist in order to
   * be absent. Freezing it out would make a recovery action unreachable on
   * precisely the pre-existing PRs that need recovering — 475 were sitting at
   * IN_PROCUREMENT_REVIEW with a snapshot taken before migration 060, and
   * PR-2026-201649 among them.
   *
   * So this merges exactly one named step and touches no existing entry. Admin
   * edits to steps already in the snapshot still cannot reach the PR. The
   * alternative — ignoring the snapshot entirely for this one action — would
   * also let an admin's edit of `hod_review` or `procurement` leak in, which is
   * exactly what the snapshot was built to prevent.
   */
  async ensureStepInSnapshot(prId: string, stepKey: string): Promise<boolean> {
    const live = await this.db.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM workflow.steps_config WHERE id = '${this.escape(stepKey)}'`,
      [],
      { bypassRls: true },
    );
    const liveRow = live.rows[0];
    if (!liveRow) return false;

    // The key MUST be injected. `workflow.steps_config` keeps the step key in the
    // table's `id` COLUMN, not in the payload, but `loadForPr()` derives a
    // snapshot entry's key from the payload's `key` field — so a payload copied
    // across verbatim comes back as `step_N` and `steps.find(s => s.key ===
    // 'revert_to_hod')` cannot see it. Appending it without the key produced a
    // 400 on the very PR the merge was meant to rescue, while looking like it
    // had worked.
    //
    // The NOT EXISTS clause below keys on that same field, so before this fix it
    // never matched either and EVERY call appended another copy: 352 junk
    // entries across 26 snapshots before it was caught.
    const payload = { ...JSON.parse(liveRow.payload), key: stepKey };

    // IT IS INSERTED AT ITS DECLARED POSITION, NOT APPENDED.
    //
    // `stepsFromConfigRows` re-stamps every step's `order` from its ARRAY
    // POSITION (`{ ...step, order: idx + 1 }`), so the array order IS the
    // engine's priority list — the payload's own `order` is read only to decide
    // where the entry belongs. Appending therefore put the merged step LAST,
    // behind every step already in the snapshot, and a step that is last is a
    // step that never wins: the first candidate whose condition matches wins, and
    // an `always` step above it answers first.
    //
    // Measured on the reported case: cs_review_quotes (order 7) was appended to a
    // 17-step snapshot and came back as order 18, behind mc_approval (16) — so
    // `advance` with `csReviewConfirmed: true` matched mc_approval and returned
    // "Only mc can action MC approval". The step was present, correct, and
    // unreachable. Reproduced directly against the stored snapshot; the failure
    // looked exactly like the flag not arriving, which is why this comment is
    // longer than the fix.
    //
    // The boundary is the first existing step whose `order` is greater than the
    // new one's, so relative order among existing entries is preserved exactly.
    const current = await this.db.query<{ steps: string }>(
      `SELECT steps::text AS steps
         FROM workflow.pr_workflow_snapshot
        WHERE pr_id = '${this.escapeUuid(prId)}'`,
      [],
      { bypassRls: true },
    );
    const row = current.rows[0];
    if (!row) return false;

    const parsed = this.parsePayload(row.steps, 'pr_workflow_snapshot');
    if (!Array.isArray(parsed)) return false;

    const entries = parsed as Array<Record<string, unknown>>;
    // Belt and braces alongside the UPDATE guard: a snapshot that already holds
    // the step must not gain a second copy.
    if (entries.some((e) => e?.key === stepKey || e?.id === stepKey)) return false;

    const newOrder = Number(payload.order);
    const at = Number.isFinite(newOrder)
      ? entries.findIndex((e) => Number(e?.order) > newOrder)
      : -1;
    const next = at === -1
      ? [...entries, payload]
      : [...entries.slice(0, at), payload, ...entries.slice(at)];

    const upd = await this.db.query(
      `UPDATE workflow.pr_workflow_snapshot
          SET steps = '${this.escape(JSON.stringify(next))}'::jsonb,
              snapshot_at = now()
        WHERE pr_id = '${this.escapeUuid(prId)}'
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(steps) e
                           WHERE e->>'key' = '${this.escape(stepKey)}'
                              OR e->>'id'  = '${this.escape(stepKey)}')`,
      [],
      { bypassRls: true },
    );
    return (upd.rowCount ?? 0) > 0;
  }

  /**
   * Freeze the current live config against a PR.
   *
   * This is what stops an admin edit from retroactively re-routing requests that
   * are already in flight. Without it, moving the finance threshold from 1M to
   * 5M would strand a PR that was approved against the old rule: the stage it is
   * sitting in would no longer match any step, and it could never advance.
   */
  async snapshotForPr(prId: string, config: WorkflowConfig): Promise<void> {
    const payload = JSON.stringify(config.steps);
    await this.db.query(
      `INSERT INTO workflow.pr_workflow_snapshot (pr_id, steps, management_threshold)
            VALUES ('${this.escapeUuid(prId)}', '${this.escape(payload)}'::jsonb, ${Number(
        config.managementThreshold,
      )})
       ON CONFLICT (pr_id) DO UPDATE
            SET steps = EXCLUDED.steps,
                management_threshold = EXCLUDED.management_threshold,
                snapshot_at = now()`,
      [],
      { bypassRls: true },
    );
  }

  /**
   * Replace the whole routing table, RECONCILING both directions.
   *
   * Upsert-only is not enough. The grid's delete removes a step from the array
   * and saves; an upsert-only write returns 200 and leaves the row in place, so
   * the engine keeps routing through a step the admin believes they deleted —
   * the grid showing 13 steps while the engine loads 14. Removing rows absent
   * from the incoming list is what makes "Delete step" mean delete.
   *
   * A step referenced by workflow.approval_votes.step_id cannot be removed
   * without orphaning the audit trail, so its DELETE is attempted, allowed to
   * fail, and reported in `blockedDeletions` rather than aborting the save.
   * Validation happens before this is called, so a rejected config never gets
   * this far and the live table is untouched.
   */
  async saveAll(
    steps: Step[],
    userId: string | null,
  ): Promise<{ version: number; blockedDeletions: string[] }> {
    let maxVersion = 0;
    for (const [i, step] of steps.entries()) {
      const payload = JSON.stringify(stepToPayload(step));
      const orderIndex = i + 1;
      const r = await this.db.query<{ version: string }>(
        `INSERT INTO workflow.steps_config
              (id, payload, order_index, updated_by_user_id, updated_at, version)
         VALUES ('${this.escape(step.key)}', '${this.escape(payload)}'::jsonb, ${orderIndex},
                 ${userId ? `'${this.escapeUuid(userId)}'` : 'NULL'}, now(), 1)
         ON CONFLICT (id) DO UPDATE
            SET payload = EXCLUDED.payload,
                order_index = EXCLUDED.order_index,
                updated_by_user_id = EXCLUDED.updated_by_user_id,
                updated_at = now(),
                version = workflow.steps_config.version + 1
         RETURNING version`,
        [],
        { bypassRls: true },
      );
      maxVersion = Math.max(maxVersion, Number(r.rows[0]?.version ?? 1));
    }

    // Reconcile deletions.
    const incoming = steps.map(s => s.key);
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM workflow.steps_config`,
      [],
      { bypassRls: true },
    );
    const removed = existing.rows.map(r => r.id).filter(id => !incoming.includes(id));

    const blockedDeletions: string[] = [];
    for (const id of removed) {
      try {
        await this.db.query(
          `DELETE FROM workflow.steps_config WHERE id = '${this.escape(id)}'`,
          [],
          { bypassRls: true },
        );
        this.log.log(`Workflow step "${id}" removed (no longer in the submitted table).`);
      } catch (err) {
        const votes = await this.countVotes(id);
        blockedDeletions.push(
          votes > 0
            ? `Step "${id}" is still present because ${votes} approval vote(s) reference it. ` +
                `Deleting it would orphan the audit trail — give it a condition that is never true instead.`
            : `Step "${id}" could not be removed: ${(err as Error).message}`,
        );
        this.log.warn(`Workflow step "${id}" could not be removed: ${(err as Error).message}`);
      }
    }

    return { version: maxVersion, blockedDeletions };
  }

  private async countVotes(stepId: string): Promise<number> {
    try {
      const r = await this.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM workflow.approval_votes WHERE step_id = '${this.escape(stepId)}'`,
        [],
        { bypassRls: true },
      );
      return Number(r.rows[0]?.n ?? 0);
    } catch {
      return 0;
    }
  }

  /**
   * Delete a step.
   *
   * workflow.approval_votes.step_id references steps_config(id), so a step that
   * has already been used in a vote cannot be removed without orphaning the
   * audit trail. The FK error is surfaced as-is so the UI can say "this step is
   * referenced by N votes" rather than "something went wrong".
   */
  async deleteStep(key: string, userId: string | null): Promise<void> {
    const votes = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM workflow.approval_votes WHERE step_id = '${this.escape(key)}'`,
      [],
      { bypassRls: true },
    );
    const n = Number(votes.rows[0]?.n ?? 0);
    if (n > 0) {
      throw new Error(
        `Cannot delete step "${key}": it is referenced by ${n} approval vote(s). ` +
          `Deactivate it by giving it a "never true" condition instead, so the audit trail stays intact.`,
      );
    }
    await this.db.query(
      `DELETE FROM workflow.steps_config WHERE id = '${this.escape(key)}'`,
      [],
      { bypassRls: true },
    );
  }

  async getThreshold(): Promise<number> {
    const r = await this.db.query<{ value: string }>(
      `SELECT value::text AS value FROM workflow.config WHERE key = 'management_threshold'`,
      [],
      { bypassRls: true },
    );
    const n = Number(r.rows[0]?.value);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MANAGEMENT_THRESHOLD;
  }

  async setThreshold(value: number, userId: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO workflow.config (key, value, updated_by_user_id, updated_at)
            VALUES ('management_threshold', to_jsonb(${Number(value)}::numeric),
                    ${userId ? `'${this.escapeUuid(userId)}'` : 'NULL'}, now())
       ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value,
                updated_by_user_id = EXCLUDED.updated_by_user_id,
                updated_at = now()`,
      [],
      { bypassRls: true },
    );
  }

  /** The canonical table the "Reset to defaults" button restores. */
  defaultSteps(): Step[] {
    return [...DEFAULT_WORKFLOW_STEPS, ...DEFAULT_GOVERNANCE_STEPS];
  }

  private fallbackConfig(reason: string): WorkflowConfig {
    this.log.warn(`Using canonical default routing (${reason}).`);
    return {
      steps: this.defaultSteps(),
      managementThreshold: DEFAULT_MANAGEMENT_THRESHOLD,
      source: 'fallback',
    };
  }

  /**
   * `payload::text` arrives as a CSV cell and therefore as a STRING. jsonb
   * rendered by ::text is single-line, so JSON.parse is safe here. Anything
   * unparseable falls back to {} rather than throwing, because one corrupt row
   * must not take the whole routing table offline.
   */
  private parsePayload(raw: unknown, where: string): unknown {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || raw.trim() === '') return {};
    try {
      return JSON.parse(raw);
    } catch {
      this.log.error(`Step payload for ${where} is not valid JSON; treating it as an empty step.`);
      return {};
    }
  }

  private escape(s: string): string {
    return s.replace(/'/g, "''");
  }

  private escapeUuid(u: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(u)) throw new Error('invalid uuid: ' + u);
    return u;
  }
}
