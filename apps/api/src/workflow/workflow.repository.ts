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
