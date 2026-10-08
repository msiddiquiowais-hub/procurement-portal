import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { roleAllowed } from '@procurement/roles';

/** Roles the prototype allows on `purchasePurpose.taggedApprovers[]`. */
export const ACK_ROLES = [
  'employee', 'dept_head', 'director', 'project_lead', 'requester_self', 'new_employee',
] as const;
export type AckRole = typeof ACK_ROLES[number];

export type TagInput = {
  taggedRole: AckRole;
  name: string;
  email: string;
  deptCode?: string;
};

@Injectable()
export class AckService {
  constructor(private readonly db: DbService) {}

  /**
   * `GET /pr/:id/acknowledgements` — the tagged-approver list for one PR.
   * Port of renderAcknowledge's "Tagged approvers" card.
   */
  async forPr(id: string, userId: string, role: string, costCenterIds: string[]) {
    const rows = await this.db.query<any>(
      `SELECT a.id, a.tagged_role, a.name, a.email, a.dept_code, a.token,
              a.acknowledged, a.acknowledged_at, a.tagged_at,
              tb.display_name AS tagged_by_name
         FROM proc.pr_acknowledgements a
         LEFT JOIN core.users tb ON tb.id = a.tagged_by
        WHERE a.pr_id = $1::uuid
        ORDER BY a.acknowledged ASC, a.tagged_at ASC`,
      [id],
      { userId, role, costCenterIds },
    );
    return { rows: this.shape(rows.rows) };
  }

  /**
   * `GET /ack` — every acknowledgement request visible to the caller, grouped
   * by PR. The prototype's acknowledge screen is reached from a `#ack=<token>`
   * email deep link; this is the authenticated equivalent, and it is what the
   * sidebar entry points at.
   */
  async inbox(userId: string, role: string, costCenterIds: string[]) {
    const rows = await this.db.query<any>(
      `SELECT a.pr_id, pr.pr_number, pr.title, pr.status, pr.estimated_amount,
              pr.currency, pr.created_at,
              u.display_name AS requester_name, d.name AS department_name,
              a.id, a.tagged_role, a.name, a.email, a.token,
              a.acknowledged, a.acknowledged_at, a.tagged_at
         FROM proc.pr_acknowledgements a
         JOIN proc.purchase_requisitions pr ON pr.id = a.pr_id
         JOIN core.users u ON u.id = pr.requester_user_id
         JOIN core.departments d ON d.id = pr.department_id
        ORDER BY a.acknowledged ASC, pr.created_at DESC, a.tagged_at ASC
        LIMIT 300`,
      [],
      { userId, role, costCenterIds },
    );

    const byPr = new Map<string, any>();
    for (const r of rows.rows) {
      if (!byPr.has(r.pr_id)) {
        byPr.set(r.pr_id, {
          pr_id: r.pr_id,
          pr_number: r.pr_number,
          title: r.title,
          status: r.status,
          estimated_amount: Number(r.estimated_amount || 0),
          currency: r.currency,
          requester_name: r.requester_name,
          department_name: r.department_name,
          created_at: r.created_at,
          approvers: [],
        });
      }
      byPr.get(r.pr_id).approvers.push({
        id: r.id, tagged_role: r.tagged_role, name: r.name, email: r.email,
        token: r.token, acknowledged: r.acknowledged,
        acknowledged_at: r.acknowledged_at, tagged_at: r.tagged_at,
      });
    }

    const requests = [...byPr.values()].map((g: any) => {
      const total = g.approvers.length;
      const pending = g.approvers.filter((a: any) => !a.acknowledged).length;
      return {
        ...g,
        approvers: g.approvers,
        total,
        pending,
        acked: total - pending,
        // The prototype's ackSummaryChip() vocabulary, verbatim.
        summary: total === 0
          ? { tone: 'none', label: 'No approvers tagged' }
          : pending === 0
            ? { tone: 'done', label: `All ${total} acknowledgers done` }
            : { tone: 'pending', label: `${pending} of ${total} pending acknowledgement` },
      };
    });

    return { requests, totalPending: requests.reduce((s: number, r: any) => s + r.pending, 0) };
  }

  /**
   * `POST /pr/:id/acknowledgements` — tag approvers. Requester or an
   * oversight role only. Upserts per (pr, email); re-tagging never resets an
   * existing acknowledgement.
   */
  async tag(id: string, userId: string, role: string, costCenterIds: string[], people: TagInput[]) {
    if (!people || people.length === 0) throw new BadRequestException('at least one approver required');
    if (people.length > 20) throw new BadRequestException('at most 20 approvers per PR');

    for (const p of people) {
      if (!ACK_ROLES.includes(p.taggedRole)) {
        throw new BadRequestException(`unknown taggedRole '${p.taggedRole}' — expected one of ${ACK_ROLES.join(', ')}`);
      }
      if (!p.name || !p.name.trim()) throw new BadRequestException('approver name is required');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email || '')) {
        throw new BadRequestException(`invalid email '${p.email}'`);
      }
    }

    return this.db.withTransaction({ userId, role, costCenterIds }, async (run) => {
      const own = await run<{ requester_user_id: string }>(
        `SELECT requester_user_id FROM proc.purchase_requisitions WHERE id = $1::uuid`,
        [id],
      );
      if (own.rows.length === 0) throw new NotFoundException('PR not found');

      const isOwner = own.rows[0].requester_user_id === userId;
      const canTag = isOwner || roleAllowed(role, 'cs,procurement,cfo') || role === 'admin';
      if (!canTag) throw new BadRequestException('only the requester or an oversight role can tag approvers');

      const out = [];
      for (const p of people) {
        const r = await run<any>(
          `SELECT * FROM proc.fn_tag_acknowledgement($1::uuid, $2::uuid, $3, $4, $5, $6)`,
          [id, userId, p.taggedRole, p.name.trim(), p.email.trim().toLowerCase(), p.deptCode ?? null],
        );
        out.push(this.shapeRow(r.rows[0]));
      }
      return { rows: out };
    });
  }

  /**
   * `POST /ack/:token/accept` — record an acknowledgement from an emailed
   * deep link. Deliberately UNAUTHENTICATED: the token is the credential,
   * exactly as in the prototype where `#ack=<token>` opens on a logged-out
   * browser. RLS is bypassed for the same reason.
   *
   * Idempotent — re-opening the link reports the original timestamp rather
   * than erroring, matching the prototype's "already acknowledged" toast.
   */
  async accept(token: string, meta: { userId?: string | null; ip?: string | null; userAgent?: string | null }) {
    if (!token || token.length < 6) throw new BadRequestException('missing acknowledgement token');

    return this.db.withTransaction({ bypassRls: true }, async (run) => {
      const r = await run<any>(
        `SELECT * FROM proc.fn_accept_acknowledgement($1, $2::uuid, $3, $4)`,
        [token, meta.userId ?? null, meta.ip ?? null, meta.userAgent ?? null],
      );
      if (r.rows.length === 0) throw new NotFoundException('Invalid or expired acknowledgement link');
      const row = r.rows[0];
      return {
        pr_id: row.pr_id,
        pr_number: row.pr_number,
        pr_title: row.pr_title,
        display_name: row.display_name,
        acknowledged_at: row.acknowledged_at,
      };
    });
  }

  /** Resolve a token without recording anything — used to render the deep link banner. */
  async resolveToken(token: string) {
    const r = await this.db.query<any>(
      `SELECT a.id, a.pr_id, a.name, a.email, a.tagged_role, a.acknowledged,
              a.acknowledged_at, pr.pr_number, pr.title
         FROM proc.pr_acknowledgements a
         JOIN proc.purchase_requisitions pr ON pr.id = a.pr_id
        WHERE a.token = $1`,
      [token],
      { bypassRls: true },
    );
    if (r.rows.length === 0) return null;
    return r.rows[0];
  }

  // ── shaping ─────────────────────────────────────────────────────────────

  private shape(rows: any[]) {
    return rows.map(r => this.shapeRow(r));
  }

  private shapeRow(r: any) {
    return {
      id: r.id,
      tagged_role: r.tagged_role,
      name: r.name,
      email: r.email,
      dept_code: r.dept_code,
      token: r.token,
      acknowledged: r.acknowledged,
      acknowledged_at: r.acknowledged_at,
      tagged_at: r.tagged_at,
      tagged_by_name: r.tagged_by_name,
    };
  }
}
