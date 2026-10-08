// Workflow configuration service — the seam between the admin UI and routing.
//
// Responsibilities:
//   - hand the engine a RoutingConfig on every routing decision
//   - guarantee a write through the Part 7 builder is visible to the very next
//     routing decision (cache invalidation, not a TTL race)
//   - refuse to save a config the engine could not honour
//
// The cache exists because planAdvance runs on every PR advance and the config
// table is read through `docker exec psql`. It is invalidated on every write and
// bounded by a short TTL, so a write is never observed stale.

import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { roleAllowed } from '@procurement/roles';
import {
  PREDICATE_VOCABULARY,
  LIGHT_STAGE_LABEL,
  validateStepConfig,
  describePredicate,
  type RoutingConfig,
  type Stage,
  type Step,
  type WorkflowConfig,
} from '@procurement/workflow-engine';
import { WorkflowRepository } from './workflow.repository';

const CACHE_TTL_MS = 5_000;

/** Roles allowed to read and write the routing table. */
const CONFIG_READ_ROLES = 'procurement,cs,finance,management,mc,cfo,hod,admin';
const CONFIG_WRITE_ROLES = 'procurement,finance,management,admin';

@Injectable()
export class WorkflowService {
  private readonly log = new Logger(WorkflowService.name);
  private cached: { config: WorkflowConfig; at: number } | null = null;

  constructor(private readonly repo: WorkflowRepository) {}

  // ─── Reads ───────────────────────────────────────────────────────────────

  assertCanRead(role: string): void {
    if (!roleAllowed(role, CONFIG_READ_ROLES)) {
      throw new ForbiddenException('The workflow configuration is visible to internal staff only.');
    }
  }

  assertCanWrite(role: string): void {
    if (!roleAllowed(role, CONFIG_WRITE_ROLES)) {
      throw new ForbiddenException(
        'Only Procurement, Finance, Management or an admin may change the workflow configuration.',
      );
    }
  }

  /**
   * The live routing config, cached briefly.
   *
   * Deliberately returns a deep copy: a caller that mutates the returned steps
   * (the plan-advance path rewrites nothing, but a future editor might) must not
   * be able to poison the cache for every other request.
   */
  async getLiveConfig(): Promise<WorkflowConfig> {
    if (this.cached && Date.now() - this.cached.at < CACHE_TTL_MS) {
      return this.clone(this.cached.config);
    }
    const config = await this.repo.loadLive();
    this.cached = { config, at: Date.now() };
    if (config.source === 'fallback') {
      this.log.warn(
        'Routing is running on canonical defaults, not the database. Admin edits will not take effect.',
      );
    }
    return this.clone(config);
  }

  /**
   * The config a specific PR must be routed by.
   *
   * Prefers the PR's frozen snapshot so that an admin edit cannot strand a
   * request that is already in flight. Falls back to the live table for PRs that
   * predate snapshotting.
   */
  async getConfigForPr(prId: string): Promise<RoutingConfig> {
    const snap = await this.repo.loadForPr(prId);
    if (snap) return snap;
    return this.getLiveConfig();
  }

  /** Cached convenience for callers that have no PR to scope against. */
  async getRoutingConfig(): Promise<RoutingConfig> {
    return this.getLiveConfig();
  }

  /**
   * Freeze the current live configuration against a PR.
   *
   * Called once, when a PR is created, so that later admin edits to the routing
   * table cannot retroactively change how a request already in flight is routed.
   */
  async snapshotForPr(prId: string): Promise<void> {
    const config = await this.getLiveConfig();
    await this.repo.snapshotForPr(prId, config);
    this.log.log(
      `Froze routing config for PR ${prId} (${config.steps.length} step(s), ` +
        `threshold ${config.managementThreshold}, source ${config.source}).`,
    );
  }

  // ─── Writes ──────────────────────────────────────────────────────────────

  invalidate(): void {
    this.cached = null;
  }

  /**
   * Persist a whole routing table + threshold as one validated unit.
   *
   * Validation runs BEFORE any write so a rejected config leaves the live table
   * untouched. The Part 7 grid saves the table as a unit so that a reordering
   * and a condition edit cannot be persisted as a half-applied mix.
   */
  async saveConfig(
    steps: Step[],
    managementThreshold: number,
    role: string,
    userId: string | null,
  ): Promise<WorkflowConfig & { warnings: string[] }> {
    this.assertCanWrite(role);

    const threshold = Number(managementThreshold);
    const result = validateStepConfig(steps, threshold);
    if (!result.ok) {
      throw new BadRequestException({
        message: 'The workflow configuration is not valid, so nothing was saved.',
        errors: result.errors,
        warnings: result.warnings,
      });
    }

    const { blockedDeletions } = await this.repo.saveAll(steps, userId);
    await this.repo.setThreshold(threshold, userId);
    this.invalidate();
    this.log.log(
      `Workflow config saved: ${steps.length} step(s), threshold ${threshold}, ` +
        `${result.warnings.length} warning(s), ${blockedDeletions.length} blocked deletion(s).`,
    );
    // Warnings travel on the success path too. A config accepted with a caveat
    // must say so, otherwise the admin believes a risky edit is clean. A step
    // that could NOT be deleted belongs here as well: without it the grid would
    // silently drop a row the engine is still routing through.
    return {
      ...(await this.getLiveConfig()),
      warnings: [...result.warnings, ...blockedDeletions],
    };
  }

  async setThreshold(value: number, role: string, userId: string | null): Promise<WorkflowConfig> {
    this.assertCanWrite(role);
    const threshold = Number(value);
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new BadRequestException('The management threshold must be a non-negative number.');
    }
    await this.repo.setThreshold(threshold, userId);
    this.invalidate();
    this.log.log(`Management threshold set to ${threshold} by ${userId ?? 'unknown'}.`);
    return this.getLiveConfig();
  }

  async deleteStep(key: string, role: string): Promise<WorkflowConfig> {
    this.assertCanWrite(role);
    try {
      await this.repo.deleteStep(key, null);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    this.invalidate();
    return this.getLiveConfig();
  }

  /**
   * Restore the canonical table (the Part 7 "Reset to defaults" button).
   *
   * Upserts rather than deletes-then-inserts, because
   * workflow.approval_votes.step_id references steps_config(id) and a delete
   * would orphan the audit trail of every vote already cast against a step.
   */
  async resetToDefaults(
    role: string,
    userId: string | null,
  ): Promise<{ config: WorkflowConfig; resetWarnings: string[] }> {
    this.assertCanWrite(role);
    const defaults = this.repo.defaultSteps();
    const threshold = await this.repo.getThreshold();
    const live = await this.repo.loadLive();

    await this.repo.saveAll(defaults, userId);
    this.invalidate();

    const restored = defaults.map(s => s.key);
    const orphaned = live.steps.filter(s => !restored.includes(s.key)).map(s => s.key);
    this.log.warn(
      `Workflow config reset to defaults by ${userId ?? 'unknown'}.` +
        (orphaned.length
          ? ` ${orphaned.length} non-default step(s) left in place: ${orphaned.join(', ')}`
          : ''),
    );

    return {
      config: await this.getLiveConfig(),
      // Surfaced so the UI can tell the admin their custom steps survived rather
      // than being silently wiped. The management threshold is deliberately NOT
      // reset: it is a live business value, not a routing default.
      resetWarnings:
        orphaned.length > 0
          ? [
              `These steps are not in the default set and were left in place to protect existing approval votes: ${orphaned.join(', ')}.`,
              `The management threshold was left at ${threshold.toLocaleString('en-PK')}; "Reset to defaults" restores routing, not the threshold.`,
            ]
          : [
              `The management threshold was left at ${threshold.toLocaleString('en-PK')}; "Reset to defaults" restores routing, not the threshold.`,
            ],
    };
  }

  // ─── Presentation helpers for the Part 7 grid ────────────────────────────

  /**
   * Everything the builder needs to render, including the vocabularies it must
   * not hardcode: the closed predicate list, the stage list and their labels.
   */
  async getBuilderModel(role: string) {
    this.assertCanRead(role);
    const config = await this.getLiveConfig();
    return {
      steps: config.steps.map(s => ({
        ...s,
        conditionLabel: describePredicate(s.when, s, config.managementThreshold),
        stageLabel: LIGHT_STAGE_LABEL[s.to as Stage] ?? String(s.to),
        fromLabel: s.from === '*' ? 'Any stage' : (LIGHT_STAGE_LABEL[s.from as Stage] ?? String(s.from)),
      })),
      managementThreshold: config.managementThreshold,
      source: config.source,
      version: config.version ?? 0,
      // Shipped alongside rather than duplicated in the browser, so the dropdown
      // can never offer a condition the engine does not implement.
      predicateVocabulary: PREDICATE_VOCABULARY,
      stageLabels: LIGHT_STAGE_LABEL,
    };
  }

  private clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
  }
}
