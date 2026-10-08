// Wave 5 Track B — admin data backend.
//
// Four surfaces over the tables Wave 5 Track A created:
//   - core.settings        (the `settings` screen)
//   - core.authority_matrix (the `admin-matrix` screen)
//   - core.dimensions / core.dimension_values (the `admin-dimensions` screen)
//   - core.uom             (the `admin-uom` screen)
//
// Two rules shape everything here.
//
// 1. THE MANAGEMENT THRESHOLD HAS EXACTLY ONE OWNER. Its only home is
//    workflow.config['management_threshold'] and the engine reads THAT. Migration
//    032 tried to have it both ways by seeding a `core.settings.mgmtThresholdCr`
//    alias; migration 036 DELETED that row, because the alias held a second number
//    (the prototype's 1.0 Cr) that the engine never honoured — the exact
//    "declared but ignored field" defect Part 7 already suffered once with
//    conditionValue. There is no catalogue row for it now. `managementThreshold`
//    is intercepted before the catalogue lookup and routed to WorkflowService, so
//    there is no code path that could write a threshold into core.settings.
//
// 2. A BOUNDARY EDIT MUST REFUSE TO LAND HALF-APPLIED. The authority matrix is a
//    partition of the amount range: adjacent bands must meet exactly, with no
//    overlap and no gap. Editing one band's edge in isolation would either
//    overlap its neighbour or open a hole no amount could ever match — the same
//    complementary-pair failure the finance gate had in migration 029, where a
//    lone amount change stranded every PR in a dead band. The validator therefore
//    refuses the WHOLE save unless the submitted set is a valid partition.

import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { WorkflowService } from '../workflow/workflow.service';
import { roleAllowed } from '@procurement/roles';
import { LIGHT_ITEM_CATEGORY_IDS } from '@procurement/workflow-engine';

// The prototype's nav gating, read straight from the blueprint's screen table.
const ADMIN_READ_ROLES = 'cs,procurement,cfo';
const ADMIN_WRITE_ROLES = 'cs,procurement,cfo';
const SETTINGS_READ_ROLES = 'all';
const SETTINGS_WRITE_ROLES = 'cs,procurement,cfo,admin';

/**
 * A row of core.categories, decorated with the two facts an admin cannot get
 * from the table itself.
 *
 * `routable` is the important one: the category exists and is selectable, but the
 * workflow engine has no rule for it, so a line carrying it is never routed.
 * See the category section in AdminService.
 */
export type CategoryRow = {
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  routable: boolean;
  itemCount: number;
  lineCount: number;
  vendorCount: number;
  vendorInactiveCount: number;
};

/** Codes are stored on pr_lines and compared against routing rules. Keep them boring. */
const CATEGORY_CODE_RE = /^[A-Z0-9_]+$/;

export type AuthorityBand = {
  id?: string;
  amountMin: number;
  amountMax: number;
  category: 'CAPEX' | 'OPEX';
  requiredRoles: string[];
  routingKey: 'FAST_TRACK' | 'STANDARD' | 'BOARD';
  active: boolean;
  effectiveFrom: string;
};

const BAND_CATEGORIES = ['CAPEX', 'OPEX'] as const;
const ROUTING_KEYS = ['FAST_TRACK', 'STANDARD', 'BOARD'] as const;

@Injectable()
export class AdminService {
  constructor(
    private readonly db: DbService,
    private readonly workflow: WorkflowService,
  ) {}

  // ─── guards ───────────────────────────────────────────────────────────────

  private assertAdminRead(role: string): void {
    if (!roleAllowed(role, ADMIN_READ_ROLES)) {
      throw new ForbiddenException(
        'Authority matrix and the D365 dimensions/UOM libraries are visible to CS, Procurement and Finance only.',
      );
    }
  }

  private assertAdminWrite(role: string): void {
    if (!roleAllowed(role, ADMIN_WRITE_ROLES)) {
      throw new ForbiddenException(
        'Only CS, Procurement or Finance may change the authority matrix, the dimension library or the UOM catalog.',
      );
    }
  }

  private assertSettingsRead(role: string): void {
    if (!roleAllowed(role, SETTINGS_READ_ROLES)) {
      throw new ForbiddenException('Settings are not available to this role.');
    }
  }

  private assertSettingsWrite(role: string): void {
    if (!roleAllowed(role, SETTINGS_WRITE_ROLES)) {
      throw new ForbiddenException(
        'Only CS, Procurement, Finance or an admin may change settings.',
      );
    }
  }

  // ─── settings ─────────────────────────────────────────────────────────────

  /**
   * GET /admin/settings — the whole catalog, grouped the way the screen renders it.
   *
   * THE THRESHOLD IS NOT IN THE CATALOG. Migration 036 deleted the
   * `mgmtThresholdCr` row: it was an alias for
   * `workflow.config['management_threshold']` that the engine never read, so the
   * Settings screen could display a second number governing nothing. There is
   * now exactly one threshold, and it is returned here as `managementThreshold`
   * sourced from the workflow service — the same value the routing engine reads.
   * The screen renders that object as an editable field; it is deliberately NOT
   * presented as an ordinary catalogue row, because it is not one.
   */
  async getSettings(role: string) {
    this.assertSettingsRead(role);
    const rows = await this.db.query<any>(
      `SELECT key, value, value_type, label, description, group_name,
              is_toggle, canonical_source, sort_order, updated_at
         FROM core.settings
        ORDER BY group_name, sort_order, key`,
      [],
      { role, bypassRls: true },
    );

    const live = await this.workflow.getLiveConfig();
    const settings = rows.rows.map((r: any) => ({
      key: r.key,
      value: r.value,
      valueType: r.value_type,
      label: r.label,
      description: r.description,
      group: r.group_name,
      isToggle: r.is_toggle,
      sortOrder: r.sort_order,
      updatedAt: r.updated_at,
      canonicalSource: r.canonical_source ?? null,
    }));

    const groups = [...new Set(settings.map((s: any) => s.group))];
    return {
      settings,
      groups,
      managementThreshold: {
        // PKR, the engine's own unit.
        value: live.managementThreshold,
        displayCr: Number((live.managementThreshold / 10_000_000).toFixed(4)),
        source: live.source,
        // The screen needs to know this one is writable and where a write lands.
        editable: true,
        unit: 'PKR Cr',
        writesTo: 'workflow.config[management_threshold]',
      },
    };
  }

  /**
   * PATCH /admin/settings — a partial update, applied as one validated unit.
   *
   * `managementThreshold` is NOT a catalogue row and is intercepted before the
   * catalogue lookup: it is the PKR Cr form of
   * `workflow.config['management_threshold']` and is written through the
   * workflow service, so the screen's field and the engine's routing decision
   * cannot diverge. Everything else is validated against the catalog's declared
   * type BEFORE any write, so a rejected payload leaves the table untouched.
   */
  async patchSettings(
    patch: Record<string, unknown>,
    role: string,
    userId: string | null,
  ): Promise<{ updated: string[]; warnings: string[] }> {
    this.assertSettingsWrite(role);
    const keys = Object.keys(patch ?? {});
    if (!keys.length) throw new BadRequestException('No settings were supplied.');

    const warnings: string[] = [];
    const directWrites: Array<[string, unknown]> = [];
    let threshold: number | null = null;

    const known = await this.db.query<any>(
      `SELECT key, value_type, canonical_source FROM core.settings`,
      [],
      { role, bypassRls: true },
    );
    const byKey = new Map(known.rows.map((r: any) => [r.key, r]));

    for (const key of keys) {
      // ── the one key this table does not own ──
      if (key === 'managementThreshold') {
        const cr = Number(patch[key]);
        if (!Number.isFinite(cr) || cr < 0) {
          throw new BadRequestException('Management threshold must be a non-negative number of PKR Cr.');
        }
        const pkr = Math.round(cr * 10_000_000);
        await this.workflow.setThreshold(pkr, role, userId);
        threshold = pkr;
        warnings.push(
          `Management threshold written to workflow.config[management_threshold] (the value the routing engine reads).`,
        );
        continue;
      }

      const meta = byKey.get(key);
      if (!meta) {
        throw new BadRequestException(
          `Unknown setting "${key}". Settings cannot be invented at runtime — only ` +
            `the catalogued keys may be written.`,
        );
      }
      const raw = patch[key];

      if (meta.canonical_source) {
        // No key carries canonical_source any more (036 removed the only one),
        // but if a future migration re-introduces one, refuse it rather than
        // silently writing to the wrong table.
        throw new BadRequestException(
          `Setting "${key}" is owned by ${meta.canonical_source} and cannot be written through this endpoint.`,
        );
      }

      // Type-check against the catalog before writing anything.
      const t = meta.value_type;
      if (t === 'boolean') {
        if (typeof raw !== 'boolean') {
          throw new BadRequestException(`Setting "${key}" is a boolean; received ${typeof raw}.`);
        }
      } else if (t === 'int') {
        if (!Number.isInteger(Number(raw))) {
          throw new BadRequestException(`Setting "${key}" is an integer; received ${JSON.stringify(raw)}.`);
        }
      } else if (t === 'number') {
        if (typeof Number(raw) !== 'number' || !Number.isFinite(Number(raw))) {
          throw new BadRequestException(`Setting "${key}" is a number; received ${JSON.stringify(raw)}.`);
        }
      } else if (t === 'string') {
        if (typeof raw !== 'string') {
          throw new BadRequestException(`Setting "${key}" is a string; received ${typeof raw}.`);
        }
      }
      directWrites.push([key, raw]);
    }

    // One statement per key, but only after every key validated, so a bad entry
    // in a multi-setting save cannot leave half of it applied.
    for (const [key, value] of directWrites) {
      const json = JSON.stringify(value);
      await this.db.query(
        `UPDATE core.settings
            SET value = $1::jsonb, updated_by_user_id = $2::uuid, updated_at = now()
          WHERE key = $3`,
        [json, userId, key],
        { role, userId: userId ?? undefined, bypassRls: true },
      );
    }

    return { updated: keys, warnings };
  }

  // ─── authority matrix ─────────────────────────────────────────────────────

  /**
   * GET /admin/authority-matrix — the TWO band tables the blueprint specifies.
   *
   * Blueprint 8.1: "Routing rules per Capex/Opex class", a Capex table and an
   * Opex table, each `Amount band | Approver(s) | Routing key`. The two are
   * genuinely different — a PKR 500,000 CAPEX request needs MC and CFO, while a
   * PKR 500,000 OPEX request needs only Procurement — which is the whole reason
   * this is a split rather than one table with a nullable column.
   *
   * Retired (active = false) bands are returned separately rather than dropped,
   * so the screen can say what it superseded instead of quietly changing shape.
   */
  async getAuthorityMatrix(role: string) {
    this.assertAdminRead(role);
    const r = await this.db.query<any>(
      `SELECT id, amount_min, amount_max, category, required_roles, routing_key,
              active, effective_from
         FROM core.authority_matrix
        ORDER BY category NULLS FIRST, active DESC, amount_min`,
      [],
      { role, bypassRls: true },
    );

    const shape = (b: any) => ({
      id: b.id,
      amountMin: Number(b.amount_min),
      amountMax: Number(b.amount_max),
      category: b.category,
      requiredRoles: b.required_roles ?? [],
      routingKey: b.routing_key,
      active: b.active,
      effectiveFrom: b.effective_from,
    });

    const live = r.rows.filter((b: any) => b.active && b.category);
    const retired = r.rows.filter((b: any) => !b.active || !b.category).map(shape);

    const table = (category: string) =>
      live
        .filter((b: any) => b.category === category)
        .map(shape)
        .sort((a, b) => a.amountMin - b.amountMin);

    return {
      capexOpexSplit: true,
      tables: {
        CAPEX: table('CAPEX'),
        OPEX: table('OPEX'),
      },
      // A flat list too, so a caller that does not care about the split still
      // works, and so the validator sees exactly what the screen renders.
      bands: [...live.map(shape)].sort((a, b) =>
        String(a.category).localeCompare(String(b.category)) || a.amountMin - b.amountMin,
      ),
      retired,
      note:
        'Two independent band tables. Each is validated as its own partition of the ' +
        'amount range, so a Capex edit can never break Opex routing or vice versa.',
    };
  }

  /**
   * PUT /admin/authority-matrix — replace the whole set, or refuse it.
   *
   * Because the two tables are independent, a save may carry either, both or
   * one — and validation is per category, so a Capex edit is checked only
   * against Capex bands. Validating the union would let a Capex ceiling silently
   * "fix" an Opex gap, which is exactly the coupling the split exists to remove.
   */
  async putAuthorityMatrix(
    bands: AuthorityBand[],
    role: string,
    userId: string | null,
  ) {
    this.assertAdminWrite(role);
    const errors = this.validateBands(bands);
    if (errors.length) {
      throw new BadRequestException({
        message: 'The authority matrix is not a valid set of band partitions, so nothing was saved.',
        errors,
      });
    }

    for (const b of bands) {
      const roles = `{${(b.requiredRoles ?? []).map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(',')}}`;
      const params = [
        b.amountMin, b.amountMax, b.category, roles, b.routingKey,
        b.active !== false, b.effectiveFrom,
      ];
      if (b.id) {
        await this.db.query(
          `UPDATE core.authority_matrix
              SET amount_min = $1::numeric, amount_max = $2::numeric, category = $3,
                  required_roles = $4::text[], routing_key = $5, active = $6,
                  effective_from = $7::date
            WHERE id = $8::uuid`,
          [...params, b.id],
          { role, userId: userId ?? undefined, bypassRls: true },
        );
      } else {
        await this.db.query(
          `INSERT INTO core.authority_matrix
             (amount_min, amount_max, category, required_roles, routing_key, active, effective_from)
           VALUES ($1::numeric, $2::numeric, $3, $4::text[], $5, $6, $7::date)
           ON CONFLICT ON CONSTRAINT authority_matrix_natural_key DO UPDATE
              SET required_roles = EXCLUDED.required_roles,
                  routing_key = EXCLUDED.routing_key,
                  active = EXCLUDED.active`,
          params,
          { role, userId: userId ?? undefined, bypassRls: true },
        );
      }
    }
    return this.getAuthorityMatrix(role);
  }

  /**
   * The complementary-pair validator, PER CATEGORY.
   *
   * Pure function, so it is unit-testable without a database and so the refusal
   * reason is specific. Each category's bands must form a partition of the amount
   * range: starting at 0, meeting exactly at each boundary, no overlap and no
   * gap. An overlap gives one amount two approver sets; a gap gives it none.
   */
  validateBands(bands: AuthorityBand[]): string[] {
    const errors: string[] = [];
    if (!Array.isArray(bands) || bands.length === 0) {
      return ['At least one amount band is required.'];
    }

    // Shape checks first, and per band, so a malformed row is named rather than
    // reported as a mysterious overlap.
    for (const b of bands) {
      const cat = String(b.category ?? '').toUpperCase();
      if (!BAND_CATEGORIES.includes(cat as any)) {
        errors.push(
          `Band ${b.amountMin}..${b.amountMax}: category must be CAPEX or OPEX, received ${JSON.stringify(b.category)}.`,
        );
      }
      if (!ROUTING_KEYS.includes(b.routingKey as any)) {
        errors.push(
          `Band ${b.amountMin}..${b.amountMax}: routingKey must be FAST_TRACK, STANDARD or BOARD, received ${JSON.stringify(b.routingKey)}.`,
        );
      }
      if (!(Number(b.amountMax) > Number(b.amountMin))) {
        errors.push(`Band ${b.amountMin}..${b.amountMax}: amountMax must be greater than amountMin.`);
      }
      if (!Array.isArray(b.requiredRoles) || b.requiredRoles.length === 0) {
        errors.push(`Band ${b.amountMin}..${b.amountMax}: at least one approver role is required.`);
      }
    }
    if (errors.length) return errors;

    // Then the partition check, independently per category.
    for (const cat of BAND_CATEGORIES) {
      const own = bands
        .filter((b) => String(b.category).toUpperCase() === cat)
        .sort((x, y) => Number(x.amountMin) - Number(y.amountMin));
      if (!own.length) continue;

      if (Number(own[0].amountMin) !== 0) {
        errors.push(
          `${cat}: the lowest band must start at 0; it starts at ${own[0].amountMin}. ` +
            `${cat} amounts below it would have no approver.`,
        );
      }
      for (let i = 0; i < own.length - 1; i++) {
        const a = own[i];
        const b = own[i + 1];
        const aMax = Number(a.amountMax);
        if (aMax > Number(b.amountMin)) {
          errors.push(
            `${cat} OVERLAP: band ${a.amountMin}..${a.amountMax} overlaps band ${b.amountMin}..${b.amountMax}. ` +
              `An amount in ${a.amountMax}..${b.amountMin} would match two approver sets.`,
          );
        } else if (aMax < Number(b.amountMin)) {
          errors.push(
            `${cat} GAP: no band covers ${aMax}..${b.amountMin}. ` +
              `A request in that range would have no approver. Raise this band's ceiling or lower the next band's floor.`,
          );
        }
      }
    }
    return errors;
  }

  // ─── dimensions ───────────────────────────────────────────────────────────

  async getDimensions(role: string) {
    this.assertAdminRead(role);
    const dims = await this.db.query<any>(
      `SELECT key, label, api_name, mandatory, description, sort_order
         FROM core.dimensions ORDER BY sort_order`,
      [],
      { role, bypassRls: true },
    );
    const vals = await this.db.query<any>(
      `SELECT id, dimension_key, code, name, active, is_placeholder, sort_order
         FROM core.dimension_values
        ORDER BY dimension_key, sort_order, code`,
      [],
      { role, bypassRls: true },
    );

    return {
      dimensions: dims.rows.map((d: any) => ({
        key: d.key,
        label: d.label,
        apiName: d.api_name,
        // The prototype tags each table MANDATORY / OPTIONAL and shows the D365
        // api name plus a value count, so all three travel together.
        tag: d.mandatory ? 'MANDATORY' : 'OPTIONAL',
        mandatory: d.mandatory,
        description: d.description,
        sortOrder: d.sort_order,
        values: vals.rows
          .filter((v: any) => v.dimension_key === d.key)
          .map((v: any) => ({
            id: v.id,
            code: v.code,
            name: v.name,
            active: v.active,
            // The four empty-code prototype rows: real content, but an option that
            // can be chosen and can never satisfy a non-empty mandatory check.
            isPlaceholder: v.is_placeholder,
            sortOrder: v.sort_order,
          })),
      })),
    };
  }

  async putDimensionValue(
    dimensionKey: string,
    body: { id?: string; code?: string; name?: string; active?: boolean },
    role: string,
  ) {
    this.assertAdminWrite(role);
    const known = await this.db.query<any>(
      `SELECT 1 AS ok FROM core.dimensions WHERE key = $1`,
      [dimensionKey],
      { role, bypassRls: true },
    );
    if (!known.rowCount) {
      throw new NotFoundException(`Unknown dimension "${dimensionKey}".`);
    }
    if (!body?.id) throw new BadRequestException('A dimension value id is required.');

    const r = await this.db.query<any>(
      `UPDATE core.dimension_values
          SET code = COALESCE($1, code), name = COALESCE($2, name), active = COALESCE($3, active)
        WHERE id = $4::uuid AND dimension_key = $5
        RETURNING id, code, name, active`,
      [body.code ?? null, body.name ?? null, body.active ?? null, body.id, dimensionKey],
      { role, bypassRls: true },
    );
    if (!r.rowCount) {
      throw new NotFoundException(`No value "${body.id}" in dimension "${dimensionKey}".`);
    }
    return r.rows[0];
  }

  async postDimensionValue(
    dimensionKey: string,
    body: { code: string; name: string },
    role: string,
  ) {
    this.assertAdminWrite(role);
    const known = await this.db.query<any>(
      `SELECT 1 AS ok FROM core.dimensions WHERE key = $1`,
      [dimensionKey],
      { role, bypassRls: true },
    );
    if (!known.rowCount) throw new NotFoundException(`Unknown dimension "${dimensionKey}".`);
    if (!body?.code || !body?.name) {
      throw new BadRequestException('A dimension value needs both a code and a name.');
    }
    try {
      const r = await this.db.query<any>(
        `INSERT INTO core.dimension_values (dimension_key, code, name)
         VALUES ($1, $2, $3)
         RETURNING id, code, name, active, is_placeholder`,
        [dimensionKey, body.code, body.name],
        { role, bypassRls: true },
      );
      return r.rows[0];
    } catch (e) {
      throw new BadRequestException(
        `Could not add "${body.code}" to ${dimensionKey}: it already exists. ` +
          `Dimension values are unique per dimension.`,
      );
    }
  }

  async deleteDimensionValue(dimensionKey: string, id: string, role: string) {
    this.assertAdminWrite(role);
    const r = await this.db.query<any>(
      `DELETE FROM core.dimension_values
        WHERE id = $1::uuid AND dimension_key = $2
        RETURNING code, is_placeholder`,
      [id, dimensionKey],
      { role, bypassRls: true },
    );
    if (!r.rowCount) {
      throw new NotFoundException(`No value "${id}" in dimension "${dimensionKey}".`);
    }
    const row = r.rows[0];
    // A placeholder is the dimension's "no value" affordance. Removing it leaves
    // the picker with no blank option, which reads as a missing dimension.
    return {
      deleted: row,
      warning: row.is_placeholder
        ? `"${row.code}" was the dimension's placeholder row. Without it the picker offers no blank option.`
        : undefined,
    };
  }

  // ─── UOM catalog ──────────────────────────────────────────────────────────

  async getUoms(role: string) {
    this.assertAdminRead(role);
    const r = await this.db.query<any>(
      `SELECT code, name, active, is_d365_catalog, light_flow, sort_order
         FROM core.uom ORDER BY sort_order`,
      [],
      { role, bypassRls: true },
    );
    const rows = r.rows;
    return {
      uoms: rows.map((u: any) => ({
        code: u.code,
        name: u.name,
        active: u.active,
        inD365Catalog: u.is_d365_catalog,
        lightFlow: u.light_flow,
        sortOrder: u.sort_order,
      })),
      counts: {
        // Two OVERLAPPING sets, not complements: 9 units are in both. Reporting
        // these as "18 catalog / 10 light" is what the prototype's own two
        // counts mean, and negating one flag to get the other would be wrong.
        d365Catalog: rows.filter((u: any) => u.is_d365_catalog).length,
        lightFlow: rows.filter((u: any) => u.light_flow).length,
        inBoth: rows.filter((u: any) => u.is_d365_catalog && u.light_flow).length,
        lightFlowOnly: rows.filter((u: any) => u.light_flow && !u.is_d365_catalog).length,
        total: rows.length,
      },
    };
  }

  async putUom(
    code: string,
    body: { name?: string; active?: boolean; lightFlow?: boolean; inD365Catalog?: boolean },
    role: string,
  ) {
    this.assertAdminWrite(role);
    const r = await this.db.query<any>(
      `UPDATE core.uom
          SET name = COALESCE($1, name),
              active = COALESCE($2, active),
              light_flow = COALESCE($3, light_flow),
              is_d365_catalog = COALESCE($4, is_d365_catalog)
        WHERE code = $5
        RETURNING code, name, active, is_d365_catalog, light_flow`,
      [
        body.name ?? null,
        body.active ?? null,
        body.lightFlow ?? null,
        body.inD365Catalog ?? null,
        code.toUpperCase(),
      ],
      { role, bypassRls: true },
    );
    if (!r.rowCount) throw new NotFoundException(`Unknown unit of measure "${code}".`);
    return r.rows[0];
  }

  async postUom(body: { code: string; name: string }, role: string) {
    this.assertAdminWrite(role);
    const code = String(body?.code ?? '').trim().toUpperCase();
    if (!code || !body?.name) {
      throw new BadRequestException('A UOM needs both a code and a name.');
    }
    if (!/^[A-Z0-9]+$/.test(code)) {
      throw new BadRequestException(
        `"${code}" is not a usable UOM code. It is sent to D365 as PurchUnit, so it must be ` +
          `letters and digits only — no spaces, punctuation or accents.`,
      );
    }
    try {
      const r = await this.db.query<any>(
        `INSERT INTO core.uom (code, name, is_d365_catalog, light_flow)
         VALUES ($1, $2, $3, $4)
         RETURNING code, name, active, is_d365_catalog, light_flow`,
        [code, body.name, true, false],
        { role, bypassRls: true },
      );
      return r.rows[0];
    } catch (e) {
      throw new BadRequestException(`UOM "${code}" already exists.`);
    }
  }

  async deleteUom(code: string, role: string) {
    this.assertAdminWrite(role);
    const upper = code.toUpperCase();

    // Report the consequence BEFORE attempting the delete, so the admin is told
    // how many posted lines depend on this unit rather than being handed a raw
    // foreign-key violation that names a constraint and nothing else.
    const inUse = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM proc.pr_lines WHERE uom = $1`,
      [upper],
      { role, bypassRls: true },
    );
    const used = Number(inUse.rows[0]?.n ?? 0);
    if (used > 0) {
      throw new BadRequestException(
        `UOM "${upper}" is used by ${used} PR line${used === 1 ? '' : 's'} and cannot be removed. ` +
          `Retire it instead by setting active = false — it stops being offered on new lines ` +
          `while the existing history keeps resolving.`,
      );
    }

    const r = await this.db.query<any>(
      `DELETE FROM core.uom WHERE code = $1 RETURNING code`,
      [upper],
      { role, bypassRls: true },
    );
    if (!r.rowCount) throw new NotFoundException(`Unknown unit of measure "${code}".`);
    return { deleted: r.rows[0].code };
  }

  // ─── Line categories ────────────────────────────────────────────────────────
//
// core.categories is the vocabulary the /pr/new dropdown reads and the one
// proc.pr_lines.category is foreign-keyed to (migration 047). It is admin-editable
// because it is reference data: the set of kinds of thing the business buys
// changes over time.
//
// ─── THE HONEST PART: A NEW CATEGORY IS NOT YET ROUTABLE ───────────────────────
//
// Creating a row here makes a category SELECTABLE. It does not make it routed.
//
// The approval rules live in the workflow engine, and a line rule only fires when
// proc.pr_lines.category equals one of LIGHT_ITEM_CATEGORY_IDS. A category in
// core.categories but absent from that list is offered in the dropdown, accepted
// by the foreign key, stored on the line — and then matches no rule. The line is
// never rejected and never routed. It fails silently, which is the worst possible
// outcome for a routing key.
//
// So a row added here is reported as `routable: false`, the admin screen badges
// it, and the refusal to pretend otherwise is the point: the engine's vocabulary
// is a code change, and this surface must not let a data row imply otherwise.
// db/scripts/verify_categories.sql and scripts/prove_w5j_categories.mjs both fail
// loudly on the gap.
//
// A category in use is never silently deactivated or deleted. The foreign key
// would refuse the delete by naming a constraint and explaining nothing, so the
// consequence is counted and reported first, in words.

  /**
   * Normalise and validate a category code. Kept next to the CRUD methods rather
   * than as a module function so it can throw the same BadRequestException the
   * HTTP layer already turns into a 400.
   */
  private normaliseCategoryCode(raw: unknown): string {
    const code = String(raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!code) throw new BadRequestException('A category needs a code.');
    if (!CATEGORY_CODE_RE.test(code)) {
      throw new BadRequestException(
        `"${code}" is not a usable category code. It is stored on proc.pr_lines.category and ` +
          'compared against routing rules, so it must be letters, digits and underscores only.',
      );
    }
    return code;
  }

  async getCategories(role: string) {
  this.assertAdminRead(role);
  const r = await this.db.query<any>(
    `SELECT c.code, c.name, c.description, c.active,
            (SELECT count(*)::int FROM core.items i  WHERE i.category = c.code) AS item_count,
            (SELECT count(*)::int FROM proc.pr_lines l WHERE l.category = c.code) AS line_count,
            -- How many vendors are currently mapped to this category. Counted here
            -- rather than per-row from the UI so the badge is the same number the
            -- RFQ pool would see, and so the table does not fan out into N+1
            -- queries the moment a screen wants to show it.
            --
            -- ACTIVE links only. A deactivated mapping does not route, so counting
            -- it would overstate who is reachable for this category.
            (SELECT count(*)::int FROM core.vendor_categories vc
              WHERE vc.category_id = c.id AND vc.is_active) AS vendor_count,
            -- Deactivated links are shown separately rather than merged in: "3
            -- active, 2 turned off" is the fact an operator needs, and a merged
            -- total makes a switched-off vendor indistinguishable from a live one.
            (SELECT count(*)::int FROM core.vendor_categories vc
              WHERE vc.category_id = c.id AND NOT vc.is_active) AS vendor_inactive_count
       FROM core.categories c
      ORDER BY c.code`,
    [],
    { role, bypassRls: true },
  );

  const engineCodes = new Set<string>(LIGHT_ITEM_CATEGORY_IDS);
  const categories: CategoryRow[] = r.rows.map((c: any) => ({
    code: c.code,
    name: c.name,
    description: c.description,
    active: c.active,
    routable: engineCodes.has(c.code),
    itemCount: Number(c.item_count ?? 0),
    lineCount: Number(c.line_count ?? 0),
    vendorCount: Number(c.vendor_count ?? 0),
    vendorInactiveCount: Number(c.vendor_inactive_count ?? 0),
  }));

  return {
    categories,
    counts: {
      total: categories.length,
      active: categories.filter((c) => c.active).length,
      // Offered in the dropdown but matching no line rule — the silent-unroutable
      // set. Surfaced, not tolerated.
      unroutable: categories.filter((c) => c.active && !c.routable).length,
      // Active, routable, therefore both selectable AND routable.
      selectable: categories.filter((c) => c.active && c.routable).length,
    },
  };
}

async postCategory(
  body: { code?: string; name?: string; description?: string; active?: boolean },
  role: string,
) {
  this.assertAdminWrite(role);
  const code = this.normaliseCategoryCode(body?.code);
  const name = String(body?.name ?? '').trim();
  if (!name) throw new BadRequestException('A category needs a name.');

  const r = await this.db.query<any>(
    `INSERT INTO core.categories (code, name, description, active)
     VALUES ($1, $2, $3, COALESCE($4, true))
     ON CONFLICT (code) DO UPDATE
       SET name = EXCLUDED.name, description = EXCLUDED.description
     RETURNING code, name, description, active`,
    [code, name, body?.description?.trim() || null, body?.active ?? null],
    { role, bypassRls: true },
  );
  const row = r.rows[0];
  const routable = (LIGHT_ITEM_CATEGORY_IDS as readonly string[]).includes(row.code);
  return {
    ...row,
    routable,
    // Said out loud on create, because it is the single most useful thing to
    // know about a category added through this screen.
    warning: routable
      ? null
      : `${code} is selectable but matches no approval rule yet. Add it to ` +
        'LIGHT_ITEM_CATEGORIES in packages/workflow-engine/src/categories.ts to route it.',
  };
}

async putCategory(
  code: string,
  body: { name?: string; description?: string; active?: boolean },
  role: string,
) {
  this.assertAdminWrite(role);
  const target = this.normaliseCategoryCode(code);

  // Deactivating a category that stored rows still reference would leave those
  // rows pointing at something the dropdown no longer offers.
  if (body?.active === false) {
    const inUse = await this.db.query<{ lines: number; items: number }>(
      `SELECT (SELECT count(*)::int FROM proc.pr_lines WHERE category = $1) AS lines,
              (SELECT count(*)::int FROM core.items   WHERE category = $1) AS items`,
      [target],
      { role, bypassRls: true },
    );
    const lines = Number(inUse.rows[0]?.lines ?? 0);
    const items = Number(inUse.rows[0]?.items ?? 0);
    if (lines > 0 || items > 0) {
      throw new BadRequestException(
        `${target} cannot be deactivated: ${lines} stored line(s) and ${items} catalogue item(s) ` +
          'still use it. Deactivating it would leave those rows referring to a category the ' +
          'requester can no longer choose, and a stored line whose category is no longer ' +
          'selectable cannot be re-read on any screen that reads the dropdown.',
      );
    }
  }

  const r = await this.db.query<any>(
    `UPDATE core.categories
        SET name        = COALESCE($1, name),
            description = COALESCE($2, description),
            active      = COALESCE($3, active)
      WHERE code = $4
      RETURNING code, name, description, active`,
    [
      body?.name?.trim() || null,
      // An empty description is a real edit (clear it), so it is passed through
      // as an empty string rather than coalesced into "leave unchanged".
      body?.description === undefined ? null : String(body.description).trim(),
      body?.active ?? null,
      target,
    ],
    { role, bypassRls: true },
  );
  if (!r.rowCount) throw new NotFoundException(`Unknown category "${code}".`);
  const row = r.rows[0];
  return { ...row, routable: (LIGHT_ITEM_CATEGORY_IDS as readonly string[]).includes(row.code) };
}

async deleteCategory(code: string, role: string) {
  this.assertAdminWrite(role);
  const target = this.normaliseCategoryCode(code);

  // The foreign key would refuse this, but it would refuse it by naming a
  // constraint. Report the actual dependent rows instead.
  const inUse = await this.db.query<{ lines: number; items: number }>(
    `SELECT (SELECT count(*)::int FROM proc.pr_lines WHERE category = $1) AS lines,
            (SELECT count(*)::int FROM core.items   WHERE category = $1) AS items`,
    [target],
    { role, bypassRls: true },
  );
  const lines = Number(inUse.rows[0]?.lines ?? 0);
  const items = Number(inUse.rows[0]?.items ?? 0);
  if (lines > 0 || items > 0) {
    throw new BadRequestException(
      `${target} cannot be deleted: ${lines} stored line(s) and ${items} catalogue item(s) ` +
        'still reference it. Deactivate it once it is unused, or move the dependent rows first.',
    );
  }

  const r = await this.db.query<any>(
    `DELETE FROM core.categories WHERE code = $1 RETURNING code`,
    [target],
    { role, bypassRls: true },
  );
  if (!r.rowCount) throw new NotFoundException(`Unknown category "${code}".`);
  return { deleted: r.rows[0].code };
}

/**
 * Bulk upsert from CSV text.
 *
 * `mode` is explicit because the two promises are different:
 *   'merge'  — insert new codes, and update name/description on existing ones
 *   'insert' — insert only; an existing code is reported and left alone
 *
 * Every row is validated BEFORE anything is written, so a bad row 40 does not
 * leave rows 1-39 committed. The batch is refused wholesale on any invalid row
 * unless `skipInvalid` is set, in which case the valid rows land and the bad ones
 * are reported by line number.
 */
async importCategories(
  body: { csv?: string; mode?: string; skipInvalid?: boolean },
  role: string,
) {
  this.assertAdminWrite(role);

  const text = String(body?.csv ?? '');
  if (!text.trim()) throw new BadRequestException('Paste or upload some CSV first.');

  const mode = body?.mode === 'insert' ? 'insert' : 'merge';
  const skipInvalid = body?.skipInvalid === true;

  const parsed = parseCategoryCsv(text);
  if (!parsed.rows.length) {
    throw new BadRequestException(
      'No data rows found. The CSV needs a header row naming code, name and description.',
    );
  }

  const engineCodes = new Set<string>(LIGHT_ITEM_CATEGORY_IDS);
  const errors: Array<{ line: number; code: string; reason: string }> = [];
  const accepted: Array<{ line: number; code: string; name: string; description: string | null }> = [];

  parsed.rows.forEach((row, i) => {
    const line = i + 2; // +1 for zero-based index, +1 for the header
    const codeRaw = String(row.code ?? '').trim();
    if (!codeRaw) return;                      // a blank line is not an error
    // An unquoted comma in a description shows up as surplus fields. Refuse the
    // row and say so, rather than importing a description that has been cut off
    // mid-sentence with nothing to indicate it.
    if (row.extra) {
      errors.push({
        line, code: codeRaw,
        reason: `${row.extra} extra field(s) — a value probably contains an unquoted comma. ` +
          'Wrap it in double quotes.',
      });
      return;
    }
    let code: string;
    try {
      code = this.normaliseCategoryCode(codeRaw);
    } catch (e: any) {
      errors.push({ line, code: codeRaw, reason: e?.message ?? 'unusable code' });
      return;
    }
    const name = String(row.name ?? '').trim();
    if (!name) {
      errors.push({ line, code, reason: 'name is required' });
      return;
    }
    accepted.push({ line, code, name, description: String(row.description ?? '').trim() || null });
  });

  if (errors.length && !skipInvalid) {
    throw new BadRequestException(
      `Nothing was imported: ${errors.length} row(s) are invalid. Fix them, or tick ` +
        '"skip invalid rows". ' +
        errors.slice(0, 5)
          .map((e) => `line ${e.line} (${e.code || 'blank'}): ${e.reason}`)
          .join('; '),
    );
  }

  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const row of accepted) {
    const existing = await this.db.query<{ code: string }>(
      `SELECT code FROM core.categories WHERE code = $1`,
      [row.code],
      { role, bypassRls: true },
    );
    const isNew = !existing.rowCount;

    if (isNew) {
      await this.db.query(
        `INSERT INTO core.categories (code, name, description) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
        [row.code, row.name, row.description],
        { role, bypassRls: true },
      );
      created.push(row.code);
    } else if (mode === 'insert') {
      skipped.push(row.code);
    } else {
      await this.db.query(
        `UPDATE core.categories SET name = $2, description = $3 WHERE code = $1`,
        [row.code, row.name, row.description],
        { role, bypassRls: true },
      );
      updated.push(row.code);
    }
  }

  // What an admin most needs to hear after a bulk load: how many of the rows they
  // just loaded are actually routable.
  const unroutable = [...created, ...updated].filter((c) => !engineCodes.has(c));

  return {
    mode,
    created, updated, skipped,
    createdCount: created.length,
    updatedCount: updated.length,
    skippedCount: skipped.length,
    errors,
    errorCount: errors.length,
    unroutable,
    warning: unroutable.length
      ? `${unroutable.length} imported row(s) are selectable but match no approval rule yet: ` +
        `${unroutable.join(', ')}. Add them to LIGHT_ITEM_CATEGORIES in ` +
        'packages/workflow-engine/src/categories.ts to route them.'
      : null,
    };
  }
}

// ─── CSV parsing ───────────────────────────────────────────────────────────────
//
// RFC 4180, hand-rolled. There is no CSV library in this workspace, and
// db.service.ts already parses psql --csv output the same way, so this follows
// the existing precedent rather than adding a dependency for three columns.
//
// The cases that actually bite, and are handled:
//   - a quoted field containing a comma        "IT hardware, including..."
//   - an escaped quote inside a quoted field    "say ""hello"""
//   - CRLF line endings (what Excel writes)
//   - a quoted field containing a newline
//   - a UTF-8 BOM, which Excel prepends and which would otherwise corrupt the
//     first header cell so `code` never matches
export function parseCsvRecords(text: string): string[][] {  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let touched = false;   // distinguishes "" (a real empty field) from "never started"

  const endField = () => { record.push(field); field = ''; touched = false; };
  const endRecord = () => { endField(); records.push(record); record = []; };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !touched) { inQuotes = true; touched = true; continue; }
    if (ch === ',') { endField(); continue; }
    if (ch === '\r') { if (src[i + 1] === '\n') i++; endRecord(); continue; }
    if (ch === '\n') { endRecord(); continue; }
    field += ch;
    touched = true;
  }
  // A trailing newline should not manufacture an empty final record.
  if (field.length || record.length || touched) endRecord();

  return records.filter((r) => r.length > 1 || (r[0] ?? '').trim() !== '');
}

function parseCategoryCsv(text: string): {
  rows: Array<{ code: string; name: string; description: string; extra?: number }>;
  headers: string[];
} {
  const records = parseCsvRecords(text);
  if (!records.length) return { rows: [], headers: [] };

  const headers = records[0].map((h) => h.trim().toLowerCase().replace(/[\s_-]+/g, ''));
  const ix = (name: string) => headers.indexOf(name);
  const codeAt = ix('code');
  const nameAt = ix('name');
  const descAt = ix('description');

  if (codeAt < 0 || nameAt < 0) {
    throw new BadRequestException(
      `The CSV header must include "code" and "name" columns; found: ` +
        `${records[0].join(', ') || '(empty header)'}. A header row is required — the ` +
        'column order is read from it, so a guess would import data into the wrong fields.',
    );
  }

  const rows = records.slice(1).map((r) => ({
    code: r[codeAt] ?? '',
    name: r[nameAt] ?? '',
    description: descAt >= 0 ? (r[descAt] ?? '') : '',
    // A row with MORE fields than the header is almost always an unquoted comma
    // in a description — the single most common CSV mistake, and the one the
    // parser cannot fix. It is counted rather than discarded, because silently
    // dropping the tail truncates a description without telling anyone, and a
    // truncated description looks like a real one.
    extra: r.length > headers.length ? r.length - headers.length : 0,
  }));
  return { rows, headers: records[0] };
}
