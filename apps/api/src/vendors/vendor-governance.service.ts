import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DbService } from '../db/db.service';
import { roleAllowed } from '@procurement/roles';
// The RFC 4180 reader is shared with the line-category importer rather than
// written a third time: two parsers that disagree would mean a file importing
// differently depending on which screen uploaded it.
import { parseCsvRecords } from '../admin/admin.service';

/**
 * WAVE 5 TRACK E, RULE 5 — Hold/Unhold, and audited vendor changes.
 *
 * "Local portal users will only control the Hold/Unhold status. Any change to
 *  vendor profiles, categories, or hold/unhold states must be 100% immutable
 *  and logged in the audit trail."
 *
 * WHY EVERY CHANGE IS TWO STATEMENTS
 * ----------------------------------
 * A governed change is (1) an append to audit.audit_log and (2) the UPDATE of
 * core.vendors. They are issued separately, AUDIT FIRST, and both carry the same
 * `vendorChangeToken`.
 *
 * The ordering matters. If the UPDATE came first and the audit write then failed,
 * the vendor would have moved with no record of it — precisely the gap rule 5
 * exists to close. Recording the decision first means the worst case is an audit
 * entry describing an action that did not complete, which for a compliance trail
 * is a truthful and useful thing to have, rather than a silent mutation.
 *
 * (A single CTE would be tidier, but the sub-statements of a WITH are executed
 * concurrently and cannot see one another's effects, so the BEFORE trigger on
 * core.vendors would not observe the audit row. See migration 039.)
 *
 * WHY THE TOKEN EXISTS AT ALL
 * ---------------------------
 * `core.fn_vendors_governed_change_gate()` refuses any governed UPDATE that does
 * not carry `app.vendor_change_token`. Only this file sets it. That is what makes
 * "every change is recorded" a database guarantee rather than a convention: a
 * raw UPDATE from psql, a migration, or any future service is refused, so a
 * change to a vendor cannot exist outside this file without an explicit,
 * deliberate act to bypass the database.
 */
@Injectable()
export class VendorGovernanceService {
  private readonly log = new Logger('VendorGovernance');

  constructor(private readonly db: DbService) {}

  /**
   * Hold and category mapping are commercial decisions, so they sit with the
   * roles that own vendor relationships. `admin` expands to include both through
   * ROLE_ALIASES, so an admin session passes without a special case.
   */
  private assertCanGovern(role: string) {
    if (!roleAllowed(role, 'procurement,cs')) {
      throw new ForbiddenException(
        'Only Procurement or the Committee Secretary may hold a vendor or change its categories.',
      );
    }
  }

  private assertReason(reason?: string): string {
    const r = String(reason ?? '').trim();
    if (!r) {
      throw new BadRequestException(
        'A reason is required. A hold or a category change that nobody can explain later is not a control, it is a flag.',
      );
    }
    if (r.length > 500) throw new BadRequestException('The reason is too long (500 characters max).');
    return r;
  }

  /** The columns the trail shows, so a hold entry is not a wall of unrelated JSON. */
  private static async snapshot(db: DbService, vendorId: string, ctx: any) {
    const r = await db.query<any>(
      `SELECT v.id, v.vendor_code, v.legal_name, v.state, v.is_hold, v.hold_reason,
              v.held_at, v.hold_count, to_jsonb(v.preferred_categories) AS preferred_categories
         FROM core.vendors v WHERE v.id = $1::uuid`,
      [vendorId],
      ctx,
    );
    if (r.rows.length === 0) throw new NotFoundException('vendor not found');
    return r.rows[0];
  }

  /**
   * Record the intent, then make the change. The audit row is written with the
   * SAME token the UPDATE will carry, so the two are correlatable afterwards and
   * a reader can tell an intended hold from a hold that actually happened.
   */
  /**
   * Append the decision BEFORE the change is applied.
   *
   * `category_change` (the whole set replaced) and the three per-link actions
   * are kept distinguishable: "we stopped routing them there" and "we no longer
   * believe this relationship exists" are different decisions, and a reader of
   * the trail six months later needs to know which one was made.
   */
  private async appendAudit(
    vendorId: string,
    action: 'hold' | 'unhold' | 'category_change' | 'category_enable' | 'category_disable' | 'category_unlink',
    before: any, after: any, reason: string, token: string, userId: string, ctx: any,
  ) {
    await this.db.query(
      `INSERT INTO audit.audit_log
         (actor_user_id, entity, entity_id, action, before, after, correlation_id, reason)
       VALUES ($1::uuid, 'core.vendors', $2::text, $3::text, $4::jsonb, $5::jsonb, $6::text, $7::text)`,
      [
        userId, vendorId, action,
        JSON.stringify(before ?? {}), JSON.stringify(after ?? {}),
        token, reason,
      ],
      { ...ctx, vendorChangeToken: token },
    );
  }

  /** POST /vendors/:id/hold */
  async hold(vendorId: string, userId: string, role: string, costCenterIds: string[], reason?: string) {
    this.assertCanGovern(role);
    const why = this.assertReason(reason);
    const ctx = { role, userId, costCenterIds };

    const before = await VendorGovernanceService.snapshot(this.db, vendorId, ctx);
    if (before.is_hold === true || before.is_hold === 'true') {
      throw new ConflictException(`${before.legal_name} is already on hold.`);
    }

    const token = randomUUID();
    const after = { ...before, is_hold: true, hold_reason: why };
    await this.appendAudit(vendorId, 'hold', before, after, why, token, userId, ctx);

    const r = await this.db.query<any>(
      `UPDATE core.vendors
          SET is_hold = true,
              hold_reason = $2::text,
              held_at = now(),
              held_by_user_id = $3::uuid,
              hold_count = hold_count + 1
        WHERE id = $1::uuid AND NOT is_hold
        RETURNING vendor_code, legal_name, is_hold, hold_reason, held_at, hold_count`,
      [vendorId, why, userId],
      { ...ctx, vendorChangeToken: token },
    );
    if (r.rows.length === 0) {
      // Another hold landed between the snapshot and the update. The audit row
      // still stands (it records the attempt), so this is a conflict, not a loss.
      throw new ConflictException(`${before.legal_name} was put on hold by someone else a moment ago.`);
    }
    this.log.log(`held ${r.rows[0].vendor_code}: ${why}`);
    return { ...r.rows[0], held_by: userId, audit_token: token };
  }

  /** POST /vendors/:id/unhold */
  async unhold(vendorId: string, userId: string, role: string, costCenterIds: string[], reason?: string) {
    this.assertCanGovern(role);
    const why = this.assertReason(reason);
    const ctx = { role, userId, costCenterIds };

    const before = await VendorGovernanceService.snapshot(this.db, vendorId, ctx);
    const wasHeld = before.is_hold === true || before.is_hold === 'true';
    if (!wasHeld) throw new ConflictException(`${before.legal_name} is not on hold.`);

    const token = randomUUID();
    const after = { ...before, is_hold: false, hold_reason: null };
    await this.appendAudit(vendorId, 'unhold', before, after, why, token, userId, ctx);

    const r = await this.db.query<any>(
      `UPDATE core.vendors
          SET is_hold = false,
              hold_reason = NULL,
              held_at = NULL,
              held_by_user_id = NULL
        WHERE id = $1::uuid AND is_hold
        RETURNING vendor_code, legal_name, is_hold, hold_count`,
      [vendorId],
      { ...ctx, vendorChangeToken: token },
    );
    if (r.rows.length === 0) {
      throw new ConflictException(`${before.legal_name} was released by someone else a moment ago.`);
    }
    this.log.log(`released ${r.rows[0].vendor_code}: ${why}`);
    return { ...r.rows[0], released_by: userId, audit_token: token };
  }

  /**
   * POST /vendors/:id/categories — rule 3's "category mapping and assignment
   * will be managed inside our portal".
   *
   * An un-categorised vendor is allowed to EXIST (rule 2: D365 must never be
   * blocked), but it is excluded from the automatic RFQ pool, so this endpoint
   * is what clears that alert.
   *
   * ── WHAT CHANGED, AND WHY ─────────────────────────────────────────────────
   *
   * This used to write `core.vendors.preferred_categories` directly. It now
   * writes LINKS in `core.vendor_categories` (migration 048), which is where a
   * per-mapping status and its actor can live. The array is rebuilt from those
   * links by `core.fn_vendor_categories_sync_array()`, so the two can never
   * disagree — the array is a derived read model, not the source of truth.
   *
   * ── THE 12-CATEGORY CAP IS GONE ───────────────────────────────────────────
   *
   * It existed to bound a comma-separated textarea. With a searchable combobox
   * and a real join table there is no reason for an arbitrary ceiling, and an
   * artificial one becomes the thing people route around. A vendor may carry
   * 20, 50 or more groups as the business grows.
   *
   * What replaces it is not "no validation": every code is still resolved
   * against the line-category library and an unknown one is still refused, with the
   * offending values named. The difference is that a legitimate number of them
   * is no longer a 400.
   *
   * ── HISTORICAL LINKS ARE PRESERVED ────────────────────────────────────────
   *
   * Codes that were already linked but are absent from this submission are
   * DEACTIVATED, never deleted. The mapping row survives so the relationship
   * that used to hold is still readable; it simply stops routing. Per link
   * removal is `unlinkCategory` below, which is explicit and audited.
   */
  async setCategories(
    vendorId: string, userId: string, role: string, costCenterIds: string[],
    categories: string[], reason?: string,
  ) {
    this.assertCanGovern(role);
    const why = this.assertReason(reason);
    const ctx = { role, userId, costCenterIds };

    const cats = (Array.isArray(categories) ? categories : [])
      .map((c) => String(c).trim())
      .filter(Boolean);
    if (cats.length === 0) {
      throw new BadRequestException('At least one category is required to clear the un-categorised alert.');
    }

    // Resolve every code against the line-category library BEFORE writing, so an
    // unknown value cannot leave the mapping half-applied.
    const resolved = await this.resolveLineCategories(cats);
    if (resolved.unknown.length) {
      throw new BadRequestException(
        `${resolved.unknown.length} value(s) are not D365 line categories: ${resolved.unknown.join(', ')}. ` +
          `Allowed: ${resolved.known.join(', ')}.`,
      );
    }

    const before = await VendorGovernanceService.snapshot(this.db, vendorId, ctx);
    const token = randomUUID();

    await this.appendAudit(
      vendorId, 'category_change', before,
      { ...before, preferred_categories: resolved.codes },
      why, token, userId, ctx,
    );

    // Activate (or re-activate) everything submitted. ON CONFLICT DO UPDATE is
    // what makes a previously deactivated link come back to life instead of
    // colliding with the row that recorded it going away.
    for (const id of resolved.ids) {
      await this.db.query(
        `INSERT INTO core.vendor_categories (vendor_id, category_id, is_active, created_by)
         VALUES ($1::uuid, $2::uuid, true, $3::uuid)
         ON CONFLICT (vendor_id, category_id) DO UPDATE
           SET is_active = true,
               status_changed_at = now(),
               status_changed_by = $3::uuid`,
        [vendorId, id, userId],
        { ...ctx },
      );
    }

    // Anything previously active and NOT submitted is deactivated, not deleted.
    if (resolved.ids.length) {
      await this.db.query(
        `UPDATE core.vendor_categories
            SET is_active = false, status_changed_at = now(), status_changed_by = $2::uuid
          WHERE vendor_id = $1::uuid
            AND is_active
            AND NOT (category_id = ANY($3::uuid[]))`,
        [vendorId, userId, `{${resolved.ids.join(',')}}`],
        { ...ctx },
      );
    } else {
      await this.db.query(
        `UPDATE core.vendor_categories
            SET is_active = false, status_changed_at = now(), status_changed_by = $2::uuid
          WHERE vendor_id = $1::uuid AND is_active`,
        [vendorId, userId],
        { ...ctx },
      );
    }

    const after = await this.vendorCategories(vendorId, role);
    const r = await this.db.query<any>(
      `SELECT id, vendor_code, legal_name FROM core.vendors WHERE id = $1::uuid`,
      [vendorId],
      { ...ctx, vendorChangeToken: token },
    );
    if (r.rows.length === 0) throw new NotFoundException('vendor not found');

    return {
      id: r.rows[0].id,
      vendor_code: r.rows[0].vendor_code,
      legal_name: r.rows[0].legal_name,
      categories: after.categories.map((c) => c.code),
      activeCount: after.counts.active,
      inactiveCount: after.counts.inactive,
      audit_token: token,
    };
  }

  /**
   * Resolve category strings to line category dimension-value ids.
   *
   * Accepts the code or the display name, and reports every unresolved value
   * rather than failing on the first — so an operator pasting a list from a
   * spreadsheet is told about all of it at once instead of fixing one line per
   * attempt.
   */
  private async resolveLineCategories(values: string[]) {
    const r = await this.db.query<{ code: string; name: string; id: string }>(
      `SELECT id, code, name
         FROM core.categories
        WHERE active
        ORDER BY code`,
      [],
      { bypassRls: true },
    );
    const all = r.rows ?? [];
    const byKey = new Map<string, string>();
    for (const g of all) {
      byKey.set(g.code.toUpperCase(), g.id);
      byKey.set(g.name.toUpperCase(), g.id);
    }

    const ids: string[] = [];
    const codes: string[] = [];
    const unknown: string[] = [];
    const seen = new Set<string>();

    for (const v of values) {
      const id = byKey.get(v.toUpperCase());
      if (!id) { unknown.push(v); continue; }
      if (seen.has(id)) continue;              // de-duplicate: IG-OFC twice is one link
      seen.add(id);
      ids.push(id);
      const g = all.find((x) => x.id === id)!;
      codes.push(g.code);
    }

    return { ids, codes, unknown, known: all.map((g) => g.code) };
  }

  /**
   * GET /vendors/:id/categories — the forward read, for the vendor edit screen.
   *
   * Returns BOTH active and inactive links. Hiding deactivated mappings would
   * make the history of a relationship unreadable and would make "re-activate
   * the one we turned off last month" impossible from the UI.
   */
  async vendorCategories(vendorId: string, role: string) {
    const r = await this.db.query<any>(
      `SELECT vc.category_id, vc.is_active, vc.created_at, vc.status_changed_at,
              dv.code, dv.name AS category_name, dv.active AS category_active,
              bu.email AS changed_by_email, bu.display_name AS changed_by_name,
              cu.email AS created_by_email
         FROM core.vendor_categories vc
         JOIN core.categories dv ON dv.id = vc.category_id
         LEFT JOIN core.users bu ON bu.id = vc.status_changed_by
         LEFT JOIN core.users cu ON cu.id = vc.created_by
        WHERE vc.vendor_id = $1::uuid
        ORDER BY dv.code`,
      [vendorId],
      { role },
    );

    const categories = r.rows.map((x) => ({
      id: x.category_id,
      code: x.code,
      name: x.category_name,
      isActive: x.is_active,
      createdAt: x.created_at,
      statusChangedAt: x.status_changed_at,
      changedBy: x.changed_by_name ? { name: x.changed_by_name, email: x.changed_by_email } : null,
      createdBy: x.created_by_email,
    }));

    return {
      vendorId,
      categories,
      counts: {
        total: categories.length,
        active: categories.filter((c) => c.isActive).length,
        inactive: categories.filter((c) => !c.isActive).length,
      },
    };
  }

  /**
   * GET /vendors/categories/:code — the REVERSE read, for "Manage Vendors" on
   * the category side.
   *
   * Returns active and inactive links separately rather than one merged list:
   * "3 active, 2 historical" is the fact an operator needs, and a merged list
   * makes an inactive vendor indistinguishable from a live one.
   */
  async vendorsForCategory(code: string, role: string) {
    const up = String(code ?? '').trim().toUpperCase();
    if (!up) throw new BadRequestException('A category code is required.');

    const cat = await this.db.query<any>(
      `SELECT id, code, name, active
         FROM core.categories
        WHERE code = $1`,
      [up],
      { role, bypassRls: true },
    );
    if (!cat.rows.length) {
      throw new NotFoundException(`No line category called "${up}".`);
    }
    const c = cat.rows[0];

    const r = await this.db.query<any>(
      `SELECT v.id, v.vendor_code, v.legal_name, v.state, v.is_hold, v.risk_score,
              vc.is_active, vc.status_changed_at, vc.created_at,
              bu.display_name AS changed_by_name, bu.email AS changed_by_email
         FROM core.vendor_categories vc
         JOIN core.vendors v ON v.id = vc.vendor_id
         LEFT JOIN core.users bu ON bu.id = vc.status_changed_by
        WHERE vc.category_id = $1::uuid
        ORDER BY vc.is_active DESC, v.vendor_code`,
      [c.id],
      { role },
    );

    const shape = (x: any) => ({
      id: x.id,
      vendorCode: x.vendor_code,
      legalName: x.legal_name,
      state: x.state,
      isHold: x.is_hold,
      riskScore: x.risk_score,
      isActive: x.is_active,
      statusChangedAt: x.status_changed_at,
      linkedAt: x.created_at,
      changedBy: x.changed_by_name ? { name: x.changed_by_name, email: x.changed_by_email } : null,
    });

    const vendors = r.rows.map(shape);
    return {
      category: { id: c.id, code: c.code, name: c.name, active: c.active },
      vendors,
      counts: {
        total: vendors.length,
        active: vendors.filter((v) => v.isActive).length,
        inactive: vendors.filter((v) => !v.isActive).length,
      },
    };
  }

  /**
   * GET /vendors/categories — the line-category library the picker and the
   * "Manage Vendors" list read from.
   *
   * Live counts of linked vendors are computed per group rather than stored, so
   * they cannot go stale the way a denormalised counter would. INACTIVE groups
   * are returned too: a deactivated line category can still own historical links
   * that need reading, and dropping it from this list would hide those.
   */
  async categoryLibrary(role: string) {
    const r = await this.db.query<any>(
      `SELECT dv.id, dv.code, dv.name, dv.active,
              COUNT(vc.vendor_id) FILTER (WHERE vc.is_active)   AS active_vendors,
              COUNT(vc.vendor_id) FILTER (WHERE NOT vc.is_active) AS inactive_vendors
         FROM core.categories dv
         LEFT JOIN core.vendor_categories vc ON vc.category_id = dv.id
        GROUP BY dv.id, dv.code, dv.name, dv.active
        ORDER BY dv.code`,
      [],
      { role, bypassRls: true },
    );

    const items = r.rows.map((x) => ({
      id: x.id,
      code: x.code,
      name: x.name,
      active: x.active,
      sortOrder: null,
      activeVendors: Number(x.active_vendors ?? 0),
      inactiveVendors: Number(x.inactive_vendors ?? 0),
    }));

    return {
      items,
      counts: {
        total: items.length,
        activeGroups: items.filter((i) => i.active).length,
        groupsWithVendors: items.filter((i) => i.activeVendors + i.inactiveVendors > 0).length,
      },
    };
  }

  /**
   * PATCH /vendors/:id/categories/:code — enable or disable one mapping.
   *
   * Disabling is NOT unlinking. Unlinking deletes the row and loses the fact that
   * the vendor was ever considered for that group; disabling keeps it and stops
   * the routing. The brief asked for exactly this distinction, and it is why
   * `is_active` exists at all.
   *
   * Refuses to disable the LAST active link while the vendor is still usable for
   * procurement: that would silently drop the vendor out of the RFQ pool without
   * anyone having decided the vendor should stop being a supplier. Set the state
   * to Deactivated first if that is the intent — an explicit, audited decision
   * rather than a side effect of tidying a category list.
   */
  async setCategoryStatus(
    vendorId: string, code: string, isActive: boolean,
    userId: string, role: string, costCenterIds: string[], reason?: string,
  ) {
    this.assertCanGovern(role);
    const why = this.assertReason(reason);
    const ctx = { role, userId, costCenterIds };

    const found = await this.db.query<any>(
      `SELECT vc.category_id, dv.code, vc.is_active
         FROM core.vendor_categories vc
         JOIN core.categories dv ON dv.id = vc.category_id
        WHERE vc.vendor_id = $1::uuid
          AND dv.code = $2`,
      [vendorId, String(code ?? '').trim().toUpperCase()],
      { role },
    );
    if (!found.rows.length) {
      throw new NotFoundException(`Vendor ${vendorId} has no link to line category "${code}".`);
    }
    const link = found.rows[0];

    if (link.is_active === isActive) {
      return {
        categoryCode: link.code,
        isActive: link.is_active,
        unchanged: true,
      };
    }

    if (!isActive) {
      const left = await this.db.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM core.vendor_categories
          WHERE vendor_id = $1::uuid AND is_active AND category_id <> $2::uuid`,
        [vendorId, link.category_id],
        { role },
      );
      const remaining = Number(left.rows[0]?.n ?? 0);
      if (remaining === 0) {
        const v = await this.db.query<any>(
          `SELECT state FROM core.vendors WHERE id = $1::uuid`, [vendorId], { role },
        );
        const stillUsable = !['Deactivated', 'Rejected', 'Blacklisted', 'Suspended']
          .includes(String(v.rows[0]?.state));
        if (stillUsable) {
          throw new BadRequestException(
            `${link.code} is this vendor's last active line category. Disabling it would drop the ` +
              'vendor out of the automatic RFQ pool without anyone having decided the vendor ' +
              'should stop being a supplier. Set the vendor state to Deactivated first if that ' +
              'is the intent — that is an explicit decision and it is audited.',
          );
        }
      }
    }

    const before = await VendorGovernanceService.snapshot(this.db, vendorId, ctx);
    const token = randomUUID();
    await this.appendAudit(
      vendorId, isActive ? 'category_enable' : 'category_disable',
      before,
      { ...before, preferred_categories: undefined, category: link.code, is_active: isActive },
      why, token, userId, ctx,
    );

    await this.db.query(
      `UPDATE core.vendor_categories
          SET is_active = $3, status_changed_at = now(), status_changed_by = $4::uuid
        WHERE vendor_id = $1::uuid AND category_id = $2::uuid`,
      [vendorId, link.category_id, isActive, userId],
      { ...ctx },
    );

    const after = await this.vendorCategories(vendorId, role);
    return {
      categoryCode: link.code,
      isActive,
      activeCount: after.counts.active,
      inactiveCount: after.counts.inactive,
      audit_token: token,
    };
  }

  /**
   * DELETE /vendors/:id/categories/:code — remove the link entirely.
   *
   * Distinct from disabling, and the distinction is the point of the feature:
   * disabling keeps the relationship readable, deleting forgets it. The audit
   * entry records which of the two happened.
   */
  async unlinkCategory(
    vendorId: string, code: string,
    userId: string, role: string, costCenterIds: string[], reason?: string,
  ) {
    this.assertCanGovern(role);
    const why = this.assertReason(reason);
    const ctx = { role, userId, costCenterIds };

    const found = await this.db.query<any>(
      `SELECT vc.category_id, dv.code
         FROM core.vendor_categories vc
         JOIN core.categories dv ON dv.id = vc.category_id
        WHERE vc.vendor_id = $1::uuid
          AND dv.code = $2`,
      [vendorId, String(code ?? '').trim().toUpperCase()],
      { role },
    );
    if (!found.rows.length) {
      throw new NotFoundException(`Vendor ${vendorId} has no link to line category "${code}".`);
    }
    const link = found.rows[0];

    const before = await VendorGovernanceService.snapshot(this.db, vendorId, ctx);
    const token = randomUUID();
    await this.appendAudit(
      vendorId, 'category_unlink', before,
      { ...before, category: link.code }, why, token, userId, ctx,
    );

    await this.db.query(
      `DELETE FROM core.vendor_categories WHERE vendor_id = $1::uuid AND category_id = $2::uuid`,
      [vendorId, link.category_id],
      { ...ctx },
    );

    const after = await this.vendorCategories(vendorId, role);
    return {
      unlinked: link.code,
      activeCount: after.counts.active,
      inactiveCount: after.counts.inactive,
      audit_token: token,
    };
  }

  /**
   * POST /vendors/categories/import — bulk-load vendor <-> item-group links.
   *
   * CSV header: `vendor_code,item_group,is_active`
   *   vendor_code  V-00081
   *   item_group   IG-OFC   (an line category code OR its display name)
   *   is_active    true | false | yes | no | 1 | 0   (default true)
   *
   * ── WHY EVERY ROW IS VALIDATED BEFORE ANY ROW IS WRITTEN ─────────────────
   * A half-applied import is worse than a refused one: the operator fixes the
   * reported errors, re-runs, and has to work out which of the first forty rows
   * already landed. So the whole file is checked first and, unless
   * `skipInvalid` is set, nothing is written at all.
   *
   * ── WHY EACH LINK IS AUDITED INDIVIDUALLY ───────────────────────────────
   * `category_change` per vendor would be one opaque row per vendor per file.
   * The links are written through the SAME per-link actions the UI uses, so a
   * bulk import and a hand edit are indistinguishable in the trail — which is
   * the only way the trail stays worth reading.
   *
   * A change that would leave a still-usable vendor with NO active line category is
   * refused per-row, with the same reasoning as `setCategoryStatus`.
   */
  async importCategoryMappings(
    body: { csv?: string; mode?: string; skipInvalid?: boolean },
    userId: string, role: string, costCenterIds: string[],
  ) {
    this.assertCanGovern(role);
    const text = String(body?.csv ?? '');
    if (!text.trim()) throw new BadRequestException('Paste or upload some CSV first.');

    const mode = body?.mode === 'insert' ? 'insert' : 'merge';
    const skipInvalid = body?.skipInvalid === true;

    const records = parseCsvRecords(text);
    if (!records.length) {
      throw new BadRequestException(
        'No data rows found. The CSV needs a header row naming vendor_code, item_group and is_active.',
      );
    }
    const headers = records[0].map((h) => h.trim().toLowerCase().replace(/[\s_-]+/g, ''));
    const vendorAt = headers.indexOf('vendorcode');
    // The column is "category" now that the mapping speaks line categories.
    // "item_group" is still accepted, so a file written against the earlier
    // vocabulary imports instead of being refused on a header difference the
    // operator cannot be expected to notice.
    const groupAt = Math.max(headers.indexOf('category'), headers.indexOf('itemgroup'));
    const activeAt = headers.indexOf('isactive');
    if (vendorAt < 0 || groupAt < 0) {
      throw new BadRequestException(
        `The CSV header must include "vendor_code" and "category" columns; found: ` +
        `${records[0].join(', ') || '(empty header)'}. A header row is required — the column ` +
        'order is read from it, so a guess would attach links to the wrong vendors.',
      );
    }

    // ── resolve both vocabularies ONCE ────────────────────────────────────
    const vs = await this.db.query<{ id: string; vendor_code: string }>(
      `SELECT id, vendor_code FROM core.vendors`, [], { role, bypassRls: true },
    );
    const vendorByCode = new Map<string, string>();
    for (const v of vs.rows) vendorByCode.set(v.vendor_code.toUpperCase(), v.id);

    const gs = await this.db.query<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM core.categories`, [], { role, bypassRls: true },
    );
    const groupByKey = new Map<string, string>();
    for (const g of gs.rows) {
      groupByKey.set(g.code.toUpperCase(), g.id);
      groupByKey.set(g.name.toUpperCase(), g.id);
    }

    // The OTHER vocabulary, kept only so a rejection can say which one the
    // operator reached for. Resolved once for the same reason as everything else
    // here: the file is validated in one pass, not row by row against the server.
    const igs = await this.db.query<{ code: string }>(
      `SELECT code FROM core.dimension_values WHERE dimension_key = 'ItemGroup'`,
      [], { role, bypassRls: true },
    );
    const itemGroupCodes = new Set((igs.rows ?? []).map((r) => r.code.toUpperCase()));

    // existing links, so `insert` mode and the "leave one active" rule both work
    const ls = await this.db.query<{ vendor_id: string; category_id: string; is_active: boolean }>(
      `SELECT vendor_id, category_id, is_active FROM core.vendor_categories`,
      [], { role, bypassRls: true },
    );
    const activeCount = new Map<string, number>();
    for (const l of ls.rows) {
      if (l.is_active) activeCount.set(l.vendor_id, (activeCount.get(l.vendor_id) ?? 0) + 1);
    }
    const existing = new Set(ls.rows.map((l) => `${l.vendor_id}:${l.category_id}`));

    const truthy = new Set(['TRUE', 'YES', 'Y', '1', 'ACTIVE', 'ON']);
    const falsy = new Set(['FALSE', 'NO', 'N', '0', 'INACTIVE', 'OFF']);

    const planned: Array<{ line: number; vendorId: string; vendorCode: string; groupId: string; groupCode: string; isActive: boolean; fresh: boolean }> = [];
    const errors: Array<{ line: number; vendor: string; reason: string }> = [];
    const skipped: string[] = [];
    const seenInFile = new Set<string>();

    records.slice(1).forEach((r, i) => {
      const line = i + 2;
      const vendorCode = String(r[vendorAt] ?? '').trim().toUpperCase();
      const groupRaw = String(r[groupAt] ?? '').trim().toUpperCase();
      if (!vendorCode && !groupRaw) return;                       // blank line
      if (!vendorCode) { errors.push({ line, vendor: '(blank)', reason: 'no vendor_code' }); return; }
      if (!groupRaw) { errors.push({ line, vendor: vendorCode, reason: 'no item_group' }); return; }

      const vendorId = vendorByCode.get(vendorCode);
      if (!vendorId) {
        errors.push({ line, vendor: vendorCode, reason: 'no such vendor (vendor_code must match core.vendors.vendor_code)' });
        return;
      }
      const groupId = groupByKey.get(groupRaw);
      if (!groupId) {
        // Name the actual mistake. An operator pasting a mapping file written
        // against the old D365 item-group vocabulary is the most likely author of
        // this rejection, and "not a category" on its own would send them looking
        // for a typo rather than at the vocabulary they got wrong. Resolved from
        // the set collected above rather than per-row, so a 500-row file does not
        // become 500 round trips.
        errors.push({
          line, vendor: vendorCode,
          reason: itemGroupCodes.has(groupRaw)
            ? `"${groupRaw}" is a D365 item group, not a line category — a vendor maps to core.categories`
            : `"${groupRaw}" is not a line category. Allowed: ${
              gs.rows.map((g) => g.code).join(', ')}`,
        });
        return;
      }

      const rawActive = String(r[activeAt] ?? '').trim().toUpperCase();
      let isActive = true;
      if (rawActive) {
        if (truthy.has(rawActive)) isActive = true;
        else if (falsy.has(rawActive)) isActive = false;
        else {
          errors.push({ line, vendor: vendorCode, reason: `is_active "${rawActive}" is not a boolean` });
          return;
        }
      }

      const pairKey = `${vendorId}:${groupId}`;
      if (seenInFile.has(pairKey)) {
        // Two rows for one link in one file means the operator's intent is
        // ambiguous. Last-wins would silently honour whichever row happened to be
        // lower, which is not the same as "the last one".
        errors.push({ line, vendor: vendorCode, reason: 'duplicate row for the same vendor + line category in this file' });
        return;
      }
      seenInFile.add(pairKey);

      const fresh = !existing.has(pairKey);
      if (!fresh && mode === 'insert') {
        skipped.push(`${vendorCode}/${groupRaw}`);
        return;
      }
      planned.push({
        line, vendorId, vendorCode, groupId,
        groupCode: gs.rows.find((g) => g.id === groupId)!.code, isActive, fresh,
      });
    });

    if (!planned.length && !errors.length) {
      throw new BadRequestException(
        'Nothing to do: every row was already present and the mode was "insert only".',
      );
    }

    // ── the rule that needs the WHOLE file to evaluate ─────────────────────
    // Deactivating the last active link of a usable vendor is refused. Checked
    // here, against the post-import state, because a file can activate some
    // links and deactivate others for the same vendor and only the net result
    // tells you whether the vendor ends up routable.
    const projected = new Map(activeCount);
    for (const p of planned) {
      if (p.isActive) projected.set(p.vendorId, (projected.get(p.vendorId) ?? 0) + (p.fresh ? 1 : 0));
      else if (p.fresh === false) projected.set(p.vendorId, Math.max(0, (projected.get(p.vendorId) ?? 0) - 1));
    }
    const states = await this.db.query<{ id: string; state: string }>(
      `SELECT id, state FROM core.vendors WHERE id = ANY($1::uuid[])`,
      [`{${[...projected.keys()].join(',')}}`], { role, bypassRls: true },
    );
    const stateById = new Map(states.rows.map((s) => [s.id, s.state]));
    for (const p of planned) {
      if (!p.isActive && (projected.get(p.vendorId) ?? 0) === 0 && stateById.get(p.vendorId) === 'Active') {
        errors.push({
          line: p.line, vendor: p.vendorCode,
          reason: 'this would leave the vendor with no active line category; deactivate the vendor first',
        });
      }
    }

    if (errors.length && !skipInvalid) {
      throw new BadRequestException({
        message:
          `${errors.length} row(s) are invalid, so NOTHING was imported: ` +
          errors.slice(0, 15).map((e) => `line ${e.line} (${e.vendor}): ${e.reason}`).join('; ') +
          (errors.length > 15 ? ` … and ${errors.length - 15} more` : '') +
          '. Fix the file, or re-run with "skip invalid rows" to import the good ones.',
        errors,
      });
    }

    // ── write ──────────────────────────────────────────────────────────────
    let created = 0; let updated = 0; let deactivated = 0;
    for (const p of planned) {
      const why = `CSV import (line ${p.line}): ${p.vendorCode} ${p.isActive ? 'linked to' : 'linked to'} ${p.groupCode}`;

      if (p.fresh) {
        // NOT setCategories. That verb takes a vendor's ENTIRE desired set and
        // deactivates anything active but absent from the list — so calling it
        // once per row made each row cancel the previous one, and a file that
        // added three groups to a vendor left exactly one of them active. A
        // bulk import must write the rows it was given and touch nothing else.
        const before = await VendorGovernanceService.snapshot(this.db, p.vendorId, { role, userId, costCenterIds });
        const token = randomUUID();
        await this.appendAudit(
          p.vendorId, 'category_change', before,
          { ...before, category: p.groupCode, is_active: p.isActive },
          why, token, userId, { role, userId, costCenterIds },
        );
        await this.db.query(
          `INSERT INTO core.vendor_categories (vendor_id, category_id, is_active, created_by)
           VALUES ($1::uuid, $2::uuid, $3::boolean, $4::uuid)`,
          [p.vendorId, p.groupId, p.isActive, userId], { role, userId, costCenterIds },
        );
        created++;
      } else if (p.isActive) {
        // setCategoryStatus is safe here: it changes ONE link and leaves the rest
        // of the vendor's set untouched, which is exactly what a row means.
        await this.setCategoryStatus(p.vendorId, p.groupCode, true, userId, role, costCenterIds, why);
        updated++;
      } else {
        await this.setCategoryStatus(p.vendorId, p.groupCode, false, userId, role, costCenterIds, why);
        deactivated++;
      }
    }

    return {
      createdCount: created,
      updatedCount: updated,
      deactivatedCount: deactivated,
      created: planned.filter((p) => p.fresh).map((p) => `${p.vendorCode}/${p.groupCode}`),
      updated: planned.filter((p) => !p.fresh && p.isActive).map((p) => `${p.vendorCode}/${p.groupCode}`),
      deactivated: planned.filter((p) => !p.fresh && !p.isActive).map((p) => `${p.vendorCode}/${p.groupCode}`),
      skippedCount: skipped.length,
      skipped,
      errorCount: errors.length,
      errors: errors.slice(0, 50),
    };
  }

  /**
   * GET /vendors/:id/audit — the trail, read from audit.audit_log.
   *
   * Rows come back newest first with the before/after images intact. The table is
   * append-only (migration 039), so this history cannot be edited or pruned from
   * anywhere in the application, and each row carries the hash that seals it to
   * the one before it.
   */
  async auditTrail(vendorId: string, role: string, limit = 50) {
    const r = await this.db.query<any>(
      `SELECT a.id, a.ts, a.action, a.reason, a.actor_user_id, u.email AS actor_email,
              u.display_name AS actor_name, a.before, a.after, a.hash_chain_self
         FROM audit.audit_log a
         LEFT JOIN core.users u ON u.id = a.actor_user_id
        WHERE a.entity = 'core.vendors' AND a.entity_id = $1::text
        ORDER BY a.id DESC
        LIMIT $2::int`,
      [vendorId, Math.min(Math.max(Number(limit) || 50, 1), 200)],
      { role },
    );
    return { vendor_id: vendorId, entries: r.rows };
  }
}
