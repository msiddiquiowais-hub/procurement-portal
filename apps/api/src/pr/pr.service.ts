import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { WorkflowService } from '../workflow/workflow.service';
import { roleAllowed } from '@procurement/roles';
import {
  planAdvance,
  resolveLineCategory,
  type ChildPrDraft,
  type Decision,
  type PrLine,
  type PrSnapshot,
  type Stage,
} from '@procurement/workflow-engine';

export type CreatePrLineInput = {
  /**
   * Optional since migration 052 — a line may be free text.
   *
   * `undefined` means the requester described the need in their own words and no
   * catalogue row matched, and the INSERT stores NULL. The FK to core.items is
   * still enforced, so an id that IS supplied has to be a real one. Widening the
   * type is what lets the create() below write `l.itemId ?? null` honestly rather
   * than claiming every line is catalogued.
   */
  itemId?: string;
  quantity: number;
  uom: string;
  /** Omit when the price is not known yet. See create() for why that is valid. */
  unitPriceEst?: number;
  description?: string;
  preferredVendorId?: string;
  /** Per-line routing category override; null = use core.items.category. */
  category?: string;
  financialDimensions?: Record<string, string>;
};

export type CreatePrInput = {
  scope: string;
  expenseType: 'CAPEX' | 'OPEX' | 'MIXED';
  costCenterId: string;
  requiredByDate: string;       // YYYY-MM-DD
  urgency?: 'routine' | 'urgent' | 'force_majeure';
  title?: string;
  description?: string;
  purpose?: string;
  departments?: Array<{ departmentId: string; hodUserId?: string; suggested?: boolean }>;
  images?: Array<{ fileId: string; lineIndex?: number; mimeType: string; sizeBytes: number }>;
  lines: CreatePrLineInput[];
};

export type CreateCapitalPrLineInput = {
  itemId: string;
  quantity: number;
  uom: string;
  unitPriceEst: number;
  description?: string;
  glAccount?: string;
  classification?: string;
  remarks?: string;
  financialDimensions?: Record<string, string>;
  preferredVendorId?: string;
};

export type CreateCapitalPrInput = {
  title: string;
  /** Optional — derived from the cost centre when omitted. */
  departmentId?: string;
  costCenterId: string;
  scope?: string;
  expenseType: 'CAPEX' | 'OPEX' | 'MIXED';
  requiredByDate: string;
  urgency?: 'routine' | 'urgent' | 'force_majeure';
  justification?: string;
  description?: string;
  purpose?: string;
  taggedApprovers?: Array<{ taggedRole: string; name: string; email: string; deptCode?: string }>;
  images?: Array<{ fileId: string; lineIndex?: number; mimeType: string; sizeBytes: number }>;
  lines: CreateCapitalPrLineInput[];
  /** false = save as Draft. The prototype's "Save draft" / "Submit PR". */
  submit?: boolean;
};

@Injectable()
export class PrService {
  constructor(
    private readonly db: DbService,
    private readonly workflow: WorkflowService,
  ) {}

  /**
   * Normalise and validate every line's UOM against the catalog, in one query.
   *
   * Migration 034 puts a foreign key on proc.pr_lines.uom, so a non-catalog value
   * is now impossible to store. That is the right place for the invariant, but on
   * its own it is a bad developer experience: a raw foreign-key violation names
   * a constraint, not the mistake. This resolves the value to a real catalog code
   * first and refuses with a message naming what was wrong and what is available.
   *
   * Normalisation matters because the vocabulary is upper-case by definition
   * (it is sent to D365 as `PurchUnit`), and callers legitimately write 'pcs'.
   * Silently upper-casing is right; silently accepting an unknown code is not.
   */
  private async resolveUoms(codes: string[]): Promise<string[]> {
    const wanted = [...new Set(codes.map((c) => String(c ?? '').trim().toUpperCase()))];
    const r = await this.db.query<{ code: string; name: string }>(
      `SELECT code, name FROM core.uom WHERE code = ANY($1::text[])`,
      [`{${wanted.map((c) => `"${c.replace(/"/g, '\\"')}"`).join(',')}}`],
      { bypassRls: true },
    );
    const known = new Map(r.rows.map((x) => [x.code, x.name]));

    const bad = wanted.filter((c) => !known.has(c));
    if (bad.length) {
      const available = r.rows.length
        ? r.rows.map((x) => x.code).join(', ')
        : 'the catalog is empty';
      throw new BadRequestException(
        `Unknown unit of measure: ${bad.map((b) => b || '(blank)').join(', ')}. ` +
          `Valid units are: ${available}. UOM must be a D365 catalog code and is sent on every PO line as PurchUnit.`,
      );
    }
    return codes.map((c) => String(c ?? '').trim().toUpperCase());
  }

  async list(userId: string, role: string, costCenterIds: string[]) {
    const r = await this.db.query<any>(
      `SELECT pr.id, pr.pr_number, pr.status, pr.estimated_amount, pr.currency,
              pr.required_by_date, pr.urgency, pr.expense_type, pr.title, pr.purpose,
              u.display_name AS requester_name, c.code AS cost_center_code,
              d.name AS department_name
         FROM proc.purchase_requisitions pr
         JOIN core.users u ON u.id = pr.requester_user_id
         JOIN core.cost_centers c ON c.id = pr.cost_center_id
         JOIN core.departments d ON d.id = pr.department_id
        ORDER BY pr.last_updated_at DESC
        LIMIT 100`,
      [],
      { userId, role, costCenterIds },
    );
    return r.rows;
  }

  /**
   * `light-pr-list` — My Light Purchase Requests.
   *
   * Port of renderLightPRList's scoping: procurement/finance/cfo/management/cs/mc
   * see the whole org; a requester and an HOD are scoped to their own
   * department; anyone else (vendor, unscoped) sees nothing rather than
   * leaking. Returns the KPI header counters and the row set the screen needs.
   */
  /**
   * `light-pr-detail` status history. The prototype renders
   * lightStatusHistoryHtml(pr) from the PR's own statusHistory array; here the
   * equivalent is the audit trail, which is hash-chained and therefore the
   * authoritative record. `before`/`after` carry the stage transitions.
   */
  async history(id: string, userId: string, role: string, costCenterIds: string[]) {
    const r = await this.db.query<any>(
      `SELECT a.ts, a.action, a.actor_user_id, u.display_name AS actor_name,
              a.before, a.after, a.correlation_id
         FROM audit.audit_log a
         LEFT JOIN core.users u ON u.id = a.actor_user_id
        WHERE a.entity = 'proc.purchase_requisitions'
          AND a.entity_id = $1::text
        ORDER BY a.ts ASC
        LIMIT 200`,
      [id],
      { userId, role, costCenterIds },
    );

    const parse = (v: any) => {
      if (!v) return null;
      if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
      return v;
    };

    return {
      events: r.rows.map((e: any) => ({
        ts: e.ts,
        action: e.action,
        actor: e.actor_name || (e.actor_user_id ? e.actor_user_id : 'system'),
        from_stage: parse(e.before)?.status ?? null,
        to_stage: parse(e.after)?.status ?? null,
        correlation_id: e.correlation_id || null,
      })),
    };
  }

  /**
   * `my-prs` — My Purchase Requisitions.
   *
   * Port of renderMyPRs, which renders TWO tables: the legacy capital PRs
   * (PR Number / Title / Amount / Class / Status / Stage) and the lightweight
   * PRs. Both come from proc.purchase_requisitions; they are split by stage
   * vocabulary because the capital flow uses the v1 names and the light flow
   * the v2 ones.
   */
  async myPrs(userId: string, role: string, costCenterIds: string[]) {
    // Partition on `flow_kind`, not `scope`. `scope` is free business text the
    // requester types ("Laptop", "sales") — overloading it with the sentinel
    // 'CAPITAL_PR' would misfile a request who happens to type that string.
    const detailed = await this.db.query<any>(
      `SELECT pr.id, pr.pr_number, pr.title, pr.estimated_amount, pr.currency,
              pr.expense_type, pr.status, pr.routing_key, pr.last_updated_at,
              pr.capex_amount, pr.opex_amount,
              u.display_name AS requester_name, d.name AS department_name
         FROM proc.purchase_requisitions pr
         JOIN core.users u ON u.id = pr.requester_user_id
         JOIN core.departments d ON d.id = pr.department_id
        WHERE pr.flow_kind = 'CAPITAL'
        ORDER BY pr.last_updated_at DESC
        LIMIT 200`,
      [],
      { userId, role, costCenterIds },
    );

    const light = await this.db.query<any>(
      `SELECT pr.id, pr.pr_number, pr.title, pr.description, pr.estimated_amount,
              pr.currency, pr.urgency, pr.status, pr.department_id, pr.last_updated_at,
              d.name AS department_name,
              (SELECT count(*) FROM proc.pr_lines pl WHERE pl.pr_id = pr.id) AS item_count,
              (SELECT pl.quantity FROM proc.pr_lines pl
                WHERE pl.pr_id = pr.id ORDER BY pl.line_no LIMIT 1) AS first_qty,
              (SELECT pl.uom FROM proc.pr_lines pl
                WHERE pl.pr_id = pr.id ORDER BY pl.line_no LIMIT 1) AS first_uom
         FROM proc.purchase_requisitions pr
         JOIN core.departments d ON d.id = pr.department_id
        WHERE pr.flow_kind IS DISTINCT FROM 'CAPITAL'
        ORDER BY pr.last_updated_at DESC
        LIMIT 200`,
      [],
      { userId, role, costCenterIds },
    );

    return {
      detailed: detailed.rows.map((p: any) => ({
        ...p,
        estimated_amount: Number(p.estimated_amount || 0),
        capex_amount: Number(p.capex_amount || 0),
        opex_amount: Number(p.opex_amount || 0),
      })),
      light: light.rows.map((p: any) => ({
        ...p,
        estimated_amount: Number(p.estimated_amount || 0),
        item_count: Number(p.item_count || 0),
        first_qty: p.first_qty === null ? null : Number(p.first_qty),
      })),
    };
  }

  /**
   * Create a legacy capital PR. Backed by `POST /pr/capital`.
   *
   * Computes the Capex/Opex split from per-line classification and derives the
   * routing key via proc.fn_derive_routing(), so the detail screen, the
   * authority matrix and the D365 payload cannot disagree.
   */
  async createCapital(
    userId: string, role: string, costCenterIds: string[],
    input: CreateCapitalPrInput,
  ) {
    if (!input.title || !input.title.trim()) throw new BadRequestException('title is required');
    if (!input.lines?.length) throw new BadRequestException('at least one line is required');

    for (const [i, l] of input.lines.entries()) {
      if (!l.classification) {
        throw new BadRequestException(`line ${i + 1} needs a classification — every line must be Capex or Opex`);
      }
      const filled = Object.keys(l.financialDimensions || {})
        .filter(k => String((l.financialDimensions || {})[k] || '').trim()).length;
      if (filled < 4) {
        throw new BadRequestException(`line ${i + 1} needs all 4 mandatory D365 dimensions (Business Unit, Department, Cost Center, Location)`);
      }
    }

    return this.db.withTransaction({ userId, role, costCenterIds }, async (run) => {
      const cc = await run<{ department_id: string }>(
        `SELECT department_id FROM core.cost_centers WHERE id = $1::uuid`,
        [input.costCenterId],
      );
      if (cc.rows.length === 0) throw new BadRequestException('cost center not found');

      let capex = 0, opex = 0;
      for (const l of input.lines) {
        const amt = l.quantity * l.unitPriceEst;
        if (l.classification!.startsWith('CAPEX_')) capex += amt; else opex += amt;
      }
      const total = capex + opex;
      const status = input.submit ? 'Submitted' : 'Draft';

      const prNumberRes = await run(`SELECT proc.fn_next_pr_number() AS n`);
      const prNumber: string = prNumberRes.rows[0].n;

      const ins = await run<{ id: string }>(
        `INSERT INTO proc.purchase_requisitions
           (pr_number, requester_user_id, department_id, cost_center_id,
            expense_type, required_by_date, status, urgency, scope, flow_kind,
            title, description, purpose, justification,
            estimated_amount, capex_amount, opex_amount, currency, routing_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CAPITAL', $10, $11, $12, $13, $14, $15, $16, 'PKR', 'STANDARD')
         RETURNING id`,
        [
          prNumber, userId, input.departmentId || cc.rows[0].department_id, input.costCenterId,
          input.expenseType, input.requiredByDate, status, input.urgency || 'routine',
          // `scope` stays free business text; `flow_kind` is the discriminator.
          input.scope || 'Capital requisition', input.title.trim(), input.description || null,
          input.purpose || null, input.justification || null,
          total, capex, opex,
        ],
      );
      const prId = ins.rows[0].id;

      const routing = await run<{ routing_key: string }>(
        `SELECT * FROM proc.fn_derive_routing($1::numeric, $2::numeric, $3::numeric)`,
        [capex, opex, total],
      );
      await run(`UPDATE proc.purchase_requisitions SET routing_key = $1 WHERE id = $2`,
        [routing.rows[0].routing_key, prId]);

      const lineIds: string[] = [];
      const uoms = await this.resolveUoms(input.lines.map((l) => l.uom));
      for (let i = 0; i < input.lines.length; i++) {
        const l = input.lines[i];
        const row = await run<{ id: string }>(
          `INSERT INTO proc.pr_lines
             (pr_id, line_no, item_id, quantity, uom, unit_price_est, gl_account,
              description, classification, remarks, financial_dimensions,
              preferred_vendor_id, approved, category)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13,
                   -- Inherit the catalogue item's category.
                   --
                   -- This INSERT used to omit the category column entirely, so every PR
                   -- raised through the detailed flow stored NULL there while
                   -- the item it was raised against carried a perfectly good
                   -- category (the Dell Latitude fixture is IT_HARDWARE). That
                   -- silently disabled everything downstream of category: the
                   -- line-routing rules, and the RFQ roster, which is matched to
                   -- line categories via core.vendor_categories. 1201 of 1216
                   -- lines were NULL.
                   --
                   -- COALESCE, not a plain SELECT, so a free-text line with no
                   -- item_id still stores NULL — there is no catalogue row to
                   -- inherit from, and inventing an 'OTHER' would put a
                   -- fabricated category in front of procurement.
                   COALESCE((SELECT i.category FROM core.items i WHERE i.id = $3::uuid),
                            NULL))
           RETURNING id`,
          [
            prId, i + 1, l.itemId, l.quantity, uoms[i], l.unitPriceEst,
            l.glAccount || 'NA', l.description || null, l.classification,
            l.remarks || null, JSON.stringify(l.financialDimensions || {}),
            l.preferredVendorId || null, !input.submit,
          ],
        );
        lineIds.push(row.rows[0].id);
      }

      for (const a of input.taggedApprovers || []) {
        if (!a.email?.trim()) continue;
        await run(
          `SELECT * FROM proc.fn_tag_acknowledgement($1::uuid, $2::uuid, $3, $4, $5, $6)`,
          [prId, userId, a.taggedRole || 'employee', a.name || a.email, a.email.trim().toLowerCase(), a.deptCode || null],
        );
      }

      const images = input.images || [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        await run(
          `INSERT INTO proc.pr_images (pr_id, line_id, file_id, mime_type, size_bytes, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [prId, img.lineIndex !== undefined ? lineIds[img.lineIndex] ?? null : null,
           img.fileId, img.mimeType, img.sizeBytes, i],
        );
      }

      return {
        id: prId, prNumber, status,
        estimatedAmount: total, capexAmount: capex, opexAmount: opex,
        routingKey: routing.rows[0].routing_key,
      };
    });
  }

  /**
   * `pr-detail` (capital) — the detail payload the legacy screen binds to:
   * KPI band, Capex/Opex breakdown, routing, line items with classification
   * and GL account, and the 9 D365 dimensions per line.
   */
  async capitalDetail(id: string, userId: string, role: string, costCenterIds: string[]) {
    const p = await this.get(id, userId, role, costCenterIds) as any;

    const dims = await this.db.query<any>(
      `SELECT line_no, financial_dimensions FROM proc.pr_lines
        WHERE pr_id = $1::uuid ORDER BY line_no`,
      [id],
      { userId, role, costCenterIds },
    );
    const dimsByLine = new Map<number, any>();
    for (const d of dims.rows) {
      let parsed: any = d.financial_dimensions;
      if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { parsed = {}; } }
      dimsByLine.set(Number(d.line_no), parsed || {});
    }

    const capex = Number(p.capex_amount ?? 0);
    const opex = Number(p.opex_amount ?? 0);
    const total = Number(p.estimated_amount ?? 0);

    const r = await this.db.query<any>(
      `SELECT * FROM proc.fn_derive_routing($1::numeric, $2::numeric, $3::numeric)`,
      [capex, opex, total],
    );

    return {
      ...p,
      capex_amount: capex,
      opex_amount: opex,
      estimated_amount: total,
      routing: r.rows[0] || { routing_key: p.routing_key, label: p.routing_key, reason: '' },
      lines: (p.lines || []).map((l: any) => ({
        ...l,
        financialDimensions: dimsByLine.get(Number(l.line_no)) || {},
      })),
    };
  }

  async lightList(userId: string, role: string, costCenterIds: string[]) {
    const SEES_ALL = ['procurement', 'finance', 'cfo', 'management', 'cs', 'mc', 'admin'];
    const seesAll = SEES_ALL.includes(role) || roleAllowed(role, 'procurement');

    // Scope department for the requester / HOD views.
    //
    // A person's department is core.users.department_id (migration 046). It
    // used to be derived by walking cost_center_ids -> cost_centers and taking
    // the first department alphabetically, which is a cost-allocation mapping
    // being asked an org-chart question. A requester holding several cost
    // centres was silently pinned to whichever department sorted first —
    // Aisha Khan resolved to SALES from "Lahore Sales" while working in HR,
    // which is how an HR requisition ended up with no HR approver in reach.
    let scopeDept: string | null = null;
    if (role === 'requester' || role === 'hod') {
      const d = await this.db.query<{ code: string | null }>(
        `SELECT d.code
           FROM core.users u
           LEFT JOIN core.departments d ON d.id = u.department_id
          WHERE u.id = $1`,
        [userId],
        { bypassRls: true },
      );
      scopeDept = d.rows[0]?.code ?? null;
    }

    const filters: string[] = [];
    const params: any[] = [];
    if (!seesAll) {
      // A REQUESTER sees only their own submissions. This screen is
      // "My Light Purchase Requests", and a requester's department is not a
      // licence to read their colleagues' requisitions: the filter used to be
      // department-only, so any two requesters in the same department saw each
      // other's requests in full.
      //
      // An HOD sees their own DEPARTMENT — that is the job. Scoping a head of
      // department to their own rows would leave the approvals queue empty.
      if (role === 'hod') {
        if (scopeDept) {
          params.push(scopeDept);
          filters.push(`d.code = $${params.length}`);
        } else {
          // HOD with no department: show nothing. Never fall back to "all".
          const header = { total: 0, open: 0, closed: 0, seesAll: false, scopeDept: null, viewLabel: 'HOD view' };
          return { header, rows: [] };
        }
      } else {
        params.push(userId);
        filters.push(`pr.requester_user_id = $${params.length}::uuid`);
      }
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const r = await this.db.query<any>(
      `SELECT pr.id, pr.pr_number, pr.status, pr.estimated_amount, pr.amount_status, pr.currency,
              pr.title, pr.description, pr.last_updated_at,
              d.name AS department_name, d.code AS department_code,
              u.display_name AS requester_name
         FROM proc.purchase_requisitions pr
         JOIN core.users u ON u.id = pr.requester_user_id
         JOIN core.cost_centers c ON c.id = pr.cost_center_id
         JOIN core.departments d ON d.id = pr.department_id
         ${where}
        ORDER BY pr.last_updated_at DESC
        LIMIT 200`,
      params,
      { userId, role, costCenterIds },
    );

    // Line preview chips: first two lines + overflow, exactly like the prototype.
    const lineRows = r.rows.length
      ? await this.db.query<any>(
          `SELECT pl.pr_id, pl.line_no, pl.quantity, pl.uom, pl.description
             FROM proc.pr_lines pl
             JOIN proc.purchase_requisitions pr ON pr.id = pl.pr_id
             JOIN core.departments d ON d.id = pr.department_id
            ${where ? where.replace('d.code', 'd.code') : ''}
            ORDER BY pl.pr_id, pl.line_no`,
          params,
          { userId, role, costCenterIds },
        )
      : { rows: [] as any[] };

    const byPr = new Map<string, any[]>();
    for (const l of lineRows.rows) {
      if (!byPr.has(l.pr_id)) byPr.set(l.pr_id, []);
      byPr.get(l.pr_id)!.push(l);
    }

    const TERMINAL = ['D365_PUSHED', 'REJECTED', 'CLOSED'];
    const rows = r.rows.map(p => {
      const items = byPr.get(p.id) || [];
      return {
        id: p.id,
        pr_number: p.pr_number,
        title: p.title,
        description: p.description,
        department_name: p.department_name,
        department_code: p.department_code,
        requester_name: p.requester_name,
        // Null when the price is genuinely unknown, so the screen can render an
        // em-dash instead of a PKR 0 that reads like a quote.
        estimated_amount: p.amount_status === 'UNKNOWN' ? null : Number(p.estimated_amount || 0),
        amount_status: p.amount_status,
        currency: p.currency,
        status: p.status,
        last_updated_at: p.last_updated_at,
        item_count: items.length,
        items_preview: items.slice(0, 2).map(i => ({
          qty: Number(i.quantity),
          uom: i.uom,
          description: i.description,
        })),
        items_overflow: Math.max(0, items.length - 2),
      };
    });

    const total = rows.length;
    const closed = rows.filter(p => TERMINAL.includes(p.status)).length;

    return {
      header: {
        total,
        open: total - closed,
        closed,
        seesAll,
        scopeDept,
        viewLabel: seesAll ? 'Admin view' : role === 'hod' ? 'HOD view' : 'Personal view',
      },
      rows,
    };
  }

  /**
   * `approvals` — My Approvals queue. Port of renderApprovals.
   *
   * A PR appears in the queue when its current stage is owned by the viewer's
   * role (LIGHT_STAGE_OWNER), or when the viewer is one of the routed HODs on
   * a multi-department PR.
   */
  async approvalsQueue(userId: string, role: string, costCenterIds: string[]) {
    // Queue membership is decided by LIGHT_STAGE_OWNER below, not by the
    // prototype's `approvals` nav data-roles ("hod,mc,cfo,cs"). Those differ:
    // the nav list omits procurement even though IN_PROCUREMENT_REVIEW is owned
    // by it, so gating on the nav CSV would wrongly starve the procurement
    // queue. Non-approvers (requester, vendor, public) get an empty queue —
    // the requester has the My-Light-PRs screen instead, and the prototype's
    // approvals screen is not reachable for them.
    const NON_APPROVER = ['requester', 'vendor', 'public', 'system'];
    if (NON_APPROVER.includes(role)) {
      return { rows: [] };
    }

    const { LIGHT_STAGE_OWNER } = await import('@procurement/workflow-engine');
    const ownedStages = Object.entries(LIGHT_STAGE_OWNER)
      .filter(([, owner]) => owner === role || roleAllowed(role, owner))
      .map(([stage]) => stage);
    const aliasStages = role === 'admin'
      ? Object.entries(LIGHT_STAGE_OWNER).map(([stage]) => stage)
      : ownedStages;

    if (aliasStages.length === 0) return { rows: [] };

    const r = await this.db.query<any>(
      `SELECT pr.id, pr.pr_number, pr.title, pr.status, pr.estimated_amount,
              pr.amount_status, pr.currency, pr.required_by_date, pr.urgency, pr.expense_type,
              pr.last_updated_at, d.name AS department_name, d.code AS department_code,
              u.display_name AS requester_name,
              pr.warehouse_check_required, pr.split,
              -- True when this row is here because the viewer is the head of
              -- department it is routed to, not because of the stage.
              EXISTS (SELECT 1 FROM proc.pr_departments pd
                       WHERE pd.pr_id = pr.id
                         AND pd.hod_user_id = $2::uuid
                         AND pd.hod_status = 'pending') AS hod_routed
         FROM proc.purchase_requisitions pr
         JOIN core.users u ON u.id = pr.requester_user_id
         JOIN core.cost_centers c ON c.id = pr.cost_center_id
         JOIN core.departments d ON d.id = pr.department_id
        -- Two ways in. Either the current stage is owned by this viewer's role,
        -- or the viewer is the head of department this request was routed to.
        -- The second clause is what makes routing mean anything: without it a
        -- PR tagged to a HOD sits in the queue for nobody until it happens to
        -- advance into a stage that role owns, and "route this to the HOD of HR"
        -- is a row in a table that no screen reads.
        WHERE pr.status = ANY($1::text[])
           OR EXISTS (SELECT 1 FROM proc.pr_departments pd
                       WHERE pd.pr_id = pr.id
                         AND pd.hod_user_id = $2::uuid
                         AND pd.hod_status = 'pending')
        ORDER BY pr.last_updated_at DESC
        LIMIT 200`,
      [aliasStages, userId],
      { userId, role, costCenterIds },
    );

    return {
      rows: r.rows.map(p => ({
        id: p.id,
        pr_number: p.pr_number,
        title: p.title,
        status: p.status,
        stage_owner: LIGHT_STAGE_OWNER[p.status] || 'system',
        // Null while the price is unknown, so the card shows an em-dash rather
        // than a PKR 0 that reads like a quote.
        estimated_amount: p.amount_status === 'UNKNOWN' ? null : Number(p.estimated_amount || 0),
        amount_status: p.amount_status,
        currency: p.currency,
        required_by_date: p.required_by_date,
        urgency: p.urgency,
        expense_type: p.expense_type,
        department_name: p.department_name,
        department_code: p.department_code,
        requester_name: p.requester_name,
        warehouse_check_required: p.warehouse_check_required,
        is_split_parent: !!p.split,
        last_updated_at: p.last_updated_at,
      })),
    };
  }

  async get(id: string, userId: string, role: string, costCenterIds: string[]) {
    const r = await this.db.query<any>(
      `SELECT pr.*, u.display_name AS requester_name, c.code AS cost_center_code,
              d.name AS department_name
         FROM proc.purchase_requisitions pr
         JOIN core.users u ON u.id = pr.requester_user_id
         JOIN core.cost_centers c ON c.id = pr.cost_center_id
         JOIN core.departments d ON d.id = pr.department_id
        WHERE pr.id = $1`,
      [id],
      { userId, role, costCenterIds },
    );
    if (r.rows.length === 0) throw new NotFoundException('PR not found or not visible');
    // The CSV-mode DB bridge returns every column as a string except booleans.
    // Coerce the fields the screens bind to numerically or as parsed JSON so
    // the API contract is stable regardless of transport.
    const head = r.rows[0];
    if (head && typeof head.split === 'string') {
      try { head.split = JSON.parse(head.split); } catch { /* leave as-is */ }
    }

    // LEFT JOIN, not JOIN (migration 052).
    //
    // A line with no catalogue item is a VALID line, not a broken one. An INNER
    // JOIN against a NULL item_id silently drops the row — no error, just a line
    // missing from the screen the requester lands on right after submitting. This
    // is the read that decides whether free text is real, so it has to be LEFT.
    const lines = await this.db.query<any>(
      `SELECT pl.*, i.item_code AS item_code, i.name AS item_name,
              COALESCE(pl.category, i.category) AS resolved_category,
              v.legal_name AS vendor_name
         FROM proc.pr_lines pl
         LEFT JOIN core.items i ON i.id = pl.item_id
         LEFT JOIN core.vendors v ON v.id = pl.preferred_vendor_id
        WHERE pl.pr_id = $1 ORDER BY pl.line_no`,
      [id],
      { userId, role, costCenterIds },
    );
    for (const l of lines.rows) {
      l.line_no = Number(l.line_no);
      l.quantity = Number(l.quantity);
      l.unit_price_est = Number(l.unit_price_est);
    }

    const [departments, images, children] = await Promise.all([
      this.db.query<any>(
        `SELECT pd.*, d.name AS department_name, hu.display_name AS hod_name
           FROM proc.pr_departments pd
           JOIN core.departments d ON d.id = pd.department_id
           LEFT JOIN core.users hu ON hu.id = pd.hod_user_id
          WHERE pd.pr_id = $1`,
        [id], { userId, role, costCenterIds },
      ),
      this.db.query<any>(
        `SELECT pi.* FROM proc.pr_images pi WHERE pi.pr_id = $1 ORDER BY pi.sort_order`,
        [id], { userId, role, costCenterIds },
      ),
      this.db.query<any>(
        `SELECT id, pr_number, status, estimated_amount, parent_pr_id
           FROM proc.purchase_requisitions WHERE parent_pr_id = $1 ORDER BY created_at`,
        [id], { userId, role, costCenterIds },
      ),
    ]);

    return { ...head, lines: lines.rows, departments: departments.rows, images: images.rows, children: children.rows };
  }

  /**
   * Create a PR. The proc.fn_next_pr_number() function in the DB generates the
   * PR number. We compute totals here, let the trigger set the workflow
   * snapshot, then return the new id.
   */
  async create(userId: string, role: string, costCenterIds: string[], input: CreatePrInput) {
    if (input.lines.length === 0) throw new BadRequestException('at least one line required');

    // Fetch department from cost center
    const cc = await this.db.query<{ department_id: string }>(
      `SELECT department_id FROM core.cost_centers WHERE id = $1`,
      [input.costCenterId],
      { bypassRls: true },
    );
    if (cc.rows.length === 0) throw new BadRequestException('cost center not found');

    // Financial total.
    //
    // "We do not know the price yet" is a legitimate state for a requisition:
    // a laptop request goes out before anyone has picked a model, and the
    // price comes back with the RFQ quotes. This used to be impossible to
    // express, because the create screen derived a unit price from the item's
    // expense_type (CAPEX -> 50000, OPEX -> 1000) and stored the result as a
    // confident PKR figure.
    //
    // A line is priced only if the caller actually said what it costs. If NO
    // line is priced, the PR is recorded as amount_status = 'UNKNOWN' rather
    // than as 0 - see the CHECK in migration 046. The distinction matters
    // because an amount-driven gate must not read "unknown" as "cheap".
    const priced = input.lines.filter(
      (l) => l.unitPriceEst !== null && l.unitPriceEst !== undefined && Number.isFinite(l.unitPriceEst),
    );
    const amountKnown = priced.length > 0;
    const total = amountKnown
      ? input.lines.reduce((sum, l) => sum + l.quantity * (l.unitPriceEst ?? 0), 0)
      : 0;

    return this.db.withTransaction(
      { userId, role, costCenterIds },
      async (run) => {
        const prNumberRes = await run(`SELECT proc.fn_next_pr_number() AS n`);
        const prNumber: string = prNumberRes.rows[0].n;

        const ins = await run<{ id: string }>(
          `INSERT INTO proc.purchase_requisitions
             (pr_number, requester_user_id, department_id, cost_center_id,
              expense_type, required_by_date, status, urgency,
              scope, flow_kind, title, description, purpose,
              estimated_amount, amount_status, currency, routing_key)
           VALUES ($1, $2, $3, $4, $5, $6, 'Submitted', $7, $8, 'LIGHT', $9, $10, $11, $12, $13, 'PKR', 'STANDARD')
           RETURNING id`,
          [
            prNumber, userId, cc.rows[0].department_id, input.costCenterId,
            input.expenseType, input.requiredByDate, input.urgency || 'routine',
            input.scope, input.title || null, input.description || null, input.purpose || null,
            total, amountKnown ? 'ESTIMATED' : 'UNKNOWN',
          ],
        );
        const prId = ins.rows[0].id;

        const lineIds: string[] = [];
        const uoms = await this.resolveUoms(input.lines.map((l) => l.uom));
        for (let i = 0; i < input.lines.length; i++) {
          const l = input.lines[i];
          const row = await run<{ id: string }>(
            `INSERT INTO proc.pr_lines
               (pr_id, line_no, item_id, quantity, uom, unit_price_est,
                description, preferred_vendor_id, gl_account, category, approved)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'NA',
                   -- A client-supplied category wins; otherwise inherit the
                   -- catalogue item's.
                   --
                   -- This read ONLY $9 (what the browser sent), so any caller
                   -- that raised a line against a catalogue item without also
                   -- restating its category stored NULL — and NULL category
                   -- silently disables everything downstream of it: the
                   -- line-routing rules, and the RFQ roster, which
                   -- core.vendor_categories matches to vendors. A Dell Latitude
                   -- laptop line carrying no IT_HARDWARE is an RFQ that can
                   -- resolve no vendor at all.
                   --
                   -- COALESCE, not a plain subquery, so /pr/new's explicit
                   -- choice still wins, and a free-text line with no item_id
                   -- stays NULL — inventing 'OTHER' would put a fabricated
                   -- category in front of procurement.
                   COALESCE($9::text,
                            (SELECT i.category FROM core.items i WHERE i.id = $3::uuid)),
                   $10)
             RETURNING id`,
            [
              prId, i + 1, l.itemId ?? null, l.quantity, uoms[i],
              // Preserve "not priced yet" as NULL rather than coercing to 0,
              // so a line-level cost check can tell the two apart.
              l.unitPriceEst ?? null,
              l.description || null, l.preferredVendorId || null,
              l.category || null, true,
            ],
          );
          lineIds.push(row.rows[0].id);
        }

        // Multi-department HOD routing (prototype "Suggest HOD" per department).
        //
        // The approver is RESOLVED here, never taken from the request body. A
        // client-supplied hodUserId used to be written straight through, which
        // made "this request goes to the wrong department head" a field the
        // browser controlled. proc.fn_pr_departments_approver_gate() would
        // refuse such a row anyway, so honouring the client value could only
        // ever produce a 500 - resolve it and let the gate confirm it.
        //
        // The PR's OWN department is always routed, whether or not the client
        // mentioned it. Relying on the caller to list the department the PR was
        // just filed under is how a requisition ends up in Submitted with no
        // approver at all: the PR has a department (it is a NOT NULL column)
        // but the routing table did not get a row for it. `input.departments`
        // is then only ever ADDITIONAL departments a requester is pulling in.
        const routeDept = await run<{ department_id: string }>(
          `SELECT department_id FROM proc.purchase_requisitions WHERE id = $1`,
          [prId],
        );
        const deptIds = [
          ...new Set([
            routeDept.rows[0].department_id,
            ...(input.departments || []).map((d) => d.departmentId),
          ]),
        ];

        // Tracks whether any department actually resolved to a HOD, so the auto-route
        // below knows it has someone to route to.
        let routedHodCount = 0;

        for (const departmentId of deptIds) {
          // `suggested` is the prototype's "Suggest HOD" provenance pill. Only
          // the departments the requester explicitly named were suggested; the
          // PR's own department is routed by definition, so it is not.
          const explicit = (input.departments || []).find((d) => d.departmentId === departmentId);
          const routed = await run<{ hod_user_id: string | null }>(
            `INSERT INTO proc.pr_departments (pr_id, department_id, hod_user_id, suggested)
             VALUES ($1, $2, core.fn_resolve_department_hod($2::uuid), $3)
             ON CONFLICT (pr_id, department_id) DO UPDATE
               SET hod_user_id = EXCLUDED.hod_user_id, suggested = EXCLUDED.suggested
             RETURNING hod_user_id`,
            [prId, departmentId, explicit ? (explicit.suggested ?? true) : false],
          );
          if (routed.rows[0]?.hod_user_id) routedHodCount++;
        }

        // Per-line reference images. DB triggers enforce the 3-per-PR and
        // 5 MB-total caps, so a buggy caller gets a violation, not a silent
        // over-store.
        const images = input.images || [];
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          await run(
            `INSERT INTO proc.pr_images (pr_id, line_id, file_id, mime_type, size_bytes, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              prId,
              img.lineIndex !== undefined ? lineIds[img.lineIndex] ?? null : null,
              img.fileId, img.mimeType, img.sizeBytes, i,
            ],
          );
        }

        // Freeze the routing config this PR was created under.
        //
        // Without this, an admin editing the workflow mid-flight would re-route
        // requests that are already in progress: a PR sitting in
        // IN_FINANCE_REVIEW could find that no step matches its stage any more
        // and become permanently stuck. The snapshot is what makes the Part 7
        // builder safe to use on a live system.
        //
        // Frozen BEFORE the auto-route below, so the snapshot records the config
        // the PR was actually created under.
        await this.workflow.snapshotForPr(prId);

        // Auto-route to the department HOD.
        //
        // Port of the prototype's submit handler, which creates the PR at
        // SUBMITTED and then immediately transitions it:
        //
        //   // Auto-route to HOD via SUBMITTED -> IN_HOD_REVIEW transition
        //   lightTransition(pr, 'IN_HOD_REVIEW', {comment:'Auto-routed to HOD ' + ...});
        //
        // Without this the PR sits at Submitted forever: the HOD queue surfaces
        // it only through the proc.pr_departments fallback clause, the stage
        // reads "Submitted" instead of "HOD review", and the detail screen
        // renders read-only because the HOD has no action for that stage.
        //
        // Only when a HOD was actually routed above. A PR with no routed HOD
        // (a CAPITAL-flow request, say) keeps Submitted rather than being parked
        // in a queue nobody can see it in.
        if (routedHodCount > 0) {
          await run(
            `UPDATE proc.purchase_requisitions
                SET status = 'IN_HOD_REVIEW',
                    last_updated_at = now()
              WHERE id = $1`,
            [prId],
          );
        }

        return {
          id: prId,
          prNumber,
          // 'IN_HOD_REVIEW' once the auto-route above fired, matching what the
          // row now holds — a caller must not have to re-read to learn the stage.
          status: routedHodCount > 0 ? 'IN_HOD_REVIEW' : 'Submitted',
          // Null, not 0, when the price is genuinely unknown - the caller must
          // be able to render "amount to be confirmed" without having to
          // re-derive that from the status code.
          estimatedAmount: amountKnown ? total : null,
          amountStatus: amountKnown ? 'ESTIMATED' : 'UNKNOWN',
        };
      },
    );
  }

  /**
   * Advance a PR through the workflow.
   *
   * Uses planAdvance() — the line-routing aware planner. When the matched step
   * declares line rules and the approved lines resolve to more than one
   * destination, the PR is split: one child PR per destination, each carrying
   * its own line subset, with parent_pr_id linkage and a `split` audit record
   * on the parent.
   */
  async advance(
    prId: string,
    decision: Decision,
    userId: string,
    role: string,
    costCenterIds: string[],
  ) {
    return this.db.withTransaction(
      { userId, role, costCenterIds },
      async (run) => {
        const r = await run<any>(
          `SELECT id, pr_number, status, estimated_amount, expense_type, title,
                  description, purpose, department_id, cost_center_id,
                  requester_user_id, required_by_date, urgency, scope,
                  warehouse_check_required, warehouse_manager_id, warehouse_decision
             FROM proc.purchase_requisitions WHERE id = $1`,
          [prId],
        );
        if (r.rows.length === 0) throw new NotFoundException('PR not found');
        const pr = r.rows[0];

        // Cost-centre code is the actor-resolution key (LIGHT_ACTOR_REGISTRY).
        const ccRes = await run<{ code: string }>(
          `SELECT code FROM core.cost_centers WHERE id = $1`,
          [pr.cost_center_id],
        );
        const costCenterCode = ccRes.rows[0]?.code ?? null;

        const lineRows = await run<any>(
          `SELECT pl.id, pl.line_no, pl.quantity, pl.unit_price_est,
                  pl.approved, pl.rejected, pl.held, pl.rejected_reason,
                  pl.financial_dimensions,
                  pl.description,
                  COALESCE(pl.category, i.category) AS item_category
             FROM proc.pr_lines pl
             LEFT JOIN core.items i ON i.id = pl.item_id
            WHERE pl.pr_id = $1
            ORDER BY pl.line_no`,
          [prId],
        );

        const prLines: PrLine[] = lineRows.rows.map((l: any) => ({
          lineNo: l.line_no,
          itemCategory: l.item_category || 'OTHER',
          amount: Number(l.quantity) * Number(l.unit_price_est),
          qty: Number(l.quantity),
          unitPrice: Number(l.unit_price_est),
          category: l.category ?? undefined,
          financialDimensions: l.financial_dimensions ?? undefined,
          approved: l.approved,
          rejected: l.rejected,
          held: l.held,
        }));

        const snapshot: PrSnapshot = {
          id: pr.id,
          prNumber: pr.pr_number,
          status: pr.status as Stage,
          estimatedAmount: Number(pr.estimated_amount),
          expenseType: pr.expense_type,
          title: pr.title,
          description: pr.description,
          purpose: pr.purpose,
          costCenter: costCenterCode,
          lines: prLines,
          warehouseCheckRequired: pr.warehouse_check_required,
          warehouseManagerId: pr.warehouse_manager_id,
          warehouseDecision: pr.warehouse_decision,
          lineDecisions: decision?.lineDecisions || {},
        };

        // Persist the HOD's per-line disposition before routing, so the split
        // children inherit the decision and the audit trail records it.
        for (const [idxStr, disp] of Object.entries(decision?.lineDecisions || {})) {
          const idx = Number(idxStr);
          const row = lineRows.rows[idx];
          if (!row) continue;
          await run(
            `UPDATE proc.pr_lines
                SET approved = $1, rejected = $2, held = $3,
                    rejected_reason = CASE WHEN $2 THEN $4 ELSE NULL END
              WHERE id = $5`,
            [disp === 'approved', disp === 'rejected', disp === 'held', decision?.reason || null, row.id],
          );
        }

        // Stamp PR-side flags from the decision so the predicates match on
        // re-routes (no fresh decision).
        if (decision?.wantWarehouse) {
          await run(
            `UPDATE proc.purchase_requisitions SET warehouse_check_required = true WHERE id = $1`,
            [prId],
          );
          snapshot.warehouseCheckRequired = true;
        }

        // Route against the config this PR was created under (its frozen
        // snapshot), falling back to the live table for PRs that predate
        // snapshotting. This is the whole point of the Part 7 remediation: the
        // routing table is data read from the database, not a constant compiled
        // into the engine.
        const routing = await this.workflow.getConfigForPr(prId);
        const plan = planAdvance(routing, snapshot, decision);

        if (plan.kind === 'none') {
          throw new BadRequestException(
            `no workflow step matched for status=${pr.status} decision=${JSON.stringify(decision)}` +
              ` (config source: ${'source' in routing ? routing.source : 'live'})`,
          );
        }

        if (plan.kind === 'split') {
          const children = await this.persistSplit(
            run, pr, lineRows.rows, plan.children, plan.comment, costCenterCode,
          );

          await run(
            `UPDATE proc.purchase_requisitions
                SET status = $1,
                    split = $2::jsonb
              WHERE id = $3`,
            [
              plan.parentStage,
              JSON.stringify({
                by: userId,
                at: new Date().toISOString(),
                reason: plan.reason,
                childIds: children.map(c => c.id),
                children: children.map(c => ({
                  id: c.id,
                  prNumber: c.prNumber,
                  status: c.routeTo,
                  actorRole: c.actorRole,
                  lines: c.lineNumbers,
                  totalAmount: c.totalAmount,
                  reason: c.reason,
                })),
              }),
              prId,
            ],
          );

          return {
            prNumber: pr.pr_number,
            previousStage: pr.status,
            parentStage: plan.parentStage,
            split: true,
            matchedStep: plan.step.key,
            reason: plan.reason,
            children,
            evaluatedSteps: plan.evaluatedSteps,
          };
        }

        await run(
          `UPDATE proc.purchase_requisitions SET status = $1 WHERE id = $2`,
          [plan.nextStage, prId],
        );

        // Close out the routed-HOD rows when the HOD has actually decided.
        //
        // The approvals queue surfaces a PR through proc.pr_departments as well
        // as through the stage, so without this an APPROVED request keeps
        // matching `hod_status = 'pending'` and lands back in the HOD's queue
        // after it has moved on — the same PR listed at a stage the HOD no
        // longer owns. Recording the decision is what makes the routing row a
        // record of what happened rather than a permanent "pending".
        //
        // Only touched when the decision was made AT the HOD stage, so a later
        // Procurement/Finance advance never rewrites a HOD decision it did not make.
        if (pr.status === 'IN_HOD_REVIEW') {
          // `reworkRequested` sends the PR back to the requester, so that HOD has
          // not signed it off — the row stays pending and legitimately returns.
          const hodOutcome = decision.lineRejected ? 'rejected' : 'approved';
          await run(
            `UPDATE proc.pr_departments
                SET hod_status = $1,
                    hod_decided_at = now()
              WHERE pr_id = $2
                AND hod_status = 'pending'`,
            [hodOutcome, prId],
          );
        }

        return {
          prNumber: pr.pr_number,
          previousStage: pr.status,
          nextStage: plan.nextStage,
          matchedStep: plan.step.key,
          lineRoutingApplied: plan.lineRoutingApplied,
          actor: plan.actor,
          comment: plan.comment,
          evaluatedSteps: plan.evaluatedSteps,
        };
      },
    );
  }

  /**
   * Persist the child PRs for a split. Each child gets its own PR number, its
   * own line subset (re-numbered from 1), parent_pr_id linkage, and lands on
   * the destination stage its line rules selected.
   */
  private async persistSplit(
    run: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }>,
    parent: any,
    parentLineRows: any[],
    drafts: ChildPrDraft[],
    comment: string,
    costCenterCode: string | null,
  ) {
    const created: Array<{
      id: string; prNumber: string; routeTo: Stage; actorRole: string;
      lineNumbers: number[]; totalAmount: number; reason: string;
    }> = [];

    for (const draft of drafts) {
      const prNumberRes = await run(`SELECT proc.fn_next_pr_number() AS n`);
      const prNumber: string = prNumberRes.rows[0].n;

      const ins = await run<{ id: string }>(
        `INSERT INTO proc.purchase_requisitions
           (pr_number, requester_user_id, department_id, cost_center_id,
            expense_type, required_by_date, status, urgency, scope,
            title, description, purpose, parent_pr_id,
            estimated_amount, currency, routing_key, workflow_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'PKR', 'STANDARD', $15::jsonb)
         RETURNING id`,
        [
          prNumber, parent.requester_user_id, parent.department_id, parent.cost_center_id,
          parent.expense_type, parent.required_by_date, draft.routeTo,
          parent.urgency, parent.scope,
          draft.title, parent.description, parent.purpose, parent.id,
          draft.totalAmount,
          JSON.stringify({
            splitFrom: parent.pr_number,
            reason: draft.reason,
            actorRole: draft.actorRole,
            costCenter: costCenterCode,
            parentLineIdxs: draft.parentLineIdxs,
            comment,
          }),
        ],
      );
      const childId = ins.rows[0].id;

      // Re-number the child's lines from 1 — the subset is a fresh document.
      for (let n = 0; n < draft.parentLineIdxs.length; n++) {
        const src = parentLineRows[draft.parentLineIdxs[n]];
        if (!src) continue;
        await run(
          `INSERT INTO proc.pr_lines
             (pr_id, line_no, item_id, quantity, uom, unit_price_est, gl_account,
              description, category, approved)
           SELECT $1, $2, item_id, quantity, uom, unit_price_est, gl_account,
                  description, category, approved
             FROM proc.pr_lines WHERE id = $3`,
          [childId, n + 1, src.id],
        );
      }

      created.push({
        id: childId,
        prNumber,
        routeTo: draft.routeTo,
        actorRole: draft.actorRole as string,
        lineNumbers: draft.lineNumbers,
        totalAmount: draft.totalAmount,
        reason: draft.reason,
      });
    }

    return created;
  }

  /** Categories the engine will route on — feeds the Admin line-rule editor. */
  async routingCategories() {
    return { resolved: resolveLineCategory };
  }

  /**
   * Hold a PR (ON_HOLD), or resume one that is already held.
   *
   * Port of the prototype's lightOnHold and lightHodRevertForRevision, which
   * both do `lightTransition(pr, 'ON_HOLD', {comment})` — a DIRECT transition,
   * not a step walk. The distinction matters: ON_HOLD is the target of no step
   * in the routing table, so a Decision flag would have failed with "no
   * workflow step matched".
   *
   * ON_HOLD is owned by the requester (LIGHT_STAGE_OWNER), which is what makes
   * "Revert for revision" land in their queue rather than procurement's.
   */
  async hold(
    prId: string,
    userId: string,
    role: string,
    costCenterIds: string[],
    reason?: string,
    resume = false,
  ) {
    return this.db.withTransaction({ userId, role, costCenterIds }, async (run) => {
      const r = await run<any>(
        `SELECT id, pr_number, status FROM proc.purchase_requisitions WHERE id = $1`,
        [prId],
      );
      if (r.rows.length === 0) throw new NotFoundException('PR not found');
      const pr = r.rows[0];

      const nextStage = resume ? 'IN_HOD_REVIEW' : 'ON_HOLD';

      if (resume && pr.status !== 'ON_HOLD') {
        throw new BadRequestException(`PR is not on hold (status=${pr.status}).`);
      }
      if (!resume && pr.status === 'ON_HOLD') {
        throw new BadRequestException('PR is already on hold; resume it instead.');
      }

      await run(
        `UPDATE proc.purchase_requisitions SET status = $1 WHERE id = $2`,
        [nextStage, prId],
      );

      return {
        prNumber: pr.pr_number,
        previousStage: pr.status,
        nextStage,
        held: !resume,
        comment: reason || (resume ? 'Resumed from hold' : 'Placed on hold'),
      };
    });
  }
}
