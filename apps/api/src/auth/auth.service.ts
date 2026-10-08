import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DbService } from '../db/db.service';

export type LoginInput = { email: string; password?: string };
export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  costCenterIds: string[];
  /**
   * The vendor record this login acts for (Wave 4 / migration 028). Null for
   * every non-supplier session, and NOT nullable for role='vendor' — the CHECK
   * ck_users_vendor_role enforces that in the database.
   *
   * This is the ONLY thing that scopes a supplier session. Carrying it on the
   * session means the supplier endpoints can never be talked into widening their
   * own scope by a request body.
   */
  vendorId: string | null;
};

/** Columns every session read needs. `vendor_id` added by migration 028. */
const SESSION_COLUMNS = 'id, email, display_name, role, cost_center_ids, vendor_id';

/**
 * Postgres array literals look like `{val1,val2}` (no quotes for non-string
 * types, double-quoted for text). The DbService returns them as raw strings
 * via CSV mode, so parse them here before they reach controller code.
 */
function parsePostgresArrayLiteral(s: string | null | undefined): string[] {
  if (!s) return [];
  const t = s.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1);
    if (!inner) return [];
    return inner.split(',').map(x => x.replace(/^"(.*)"$/, '$1'));
  }
  return [];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Local-dev login. Reads the seeded users; for the demo we accept any
   * non-empty password (since seed.sql didn't store hashes). Production
   * would verify bcrypt against `users.password_hash` (added in a later
   * migration).
   */
  async login(input: LoginInput): Promise<{ token: string; user: AuthenticatedUser }> {
    const r = await this.db.query<{
      id: string;
      email: string;
      display_name: string;
      role: string;
      cost_center_ids: string | null;
      vendor_id: string | null;
    }>(
      `SELECT ${SESSION_COLUMNS}
         FROM core.users
        WHERE email = $1 AND active = true
        LIMIT 1`,
      [input.email],
      { bypassRls: true },
    );
    if (r.rows.length === 0) throw new UnauthorizedException('invalid credentials');
    const u = r.rows[0];
    const user: AuthenticatedUser = {
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      role: u.role,
      costCenterIds: parsePostgresArrayLiteral(u.cost_center_ids),
      vendorId: u.vendor_id ?? null,
    };
    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
    return { token, user };
  }

  async verify(token: string): Promise<AuthenticatedUser> {
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; email: string; role: string }>(token);
      const r = await this.db.query<{
        id: string;
        email: string;
        display_name: string;
        role: string;
        cost_center_ids: string | null;
        vendor_id: string | null;
      }>(
        `SELECT ${SESSION_COLUMNS}
           FROM core.users WHERE id = $1 AND active = true`,
        [payload.sub],
        { bypassRls: true },
      );
      if (r.rows.length === 0) throw new UnauthorizedException('user not found');
      const u = r.rows[0];
      return {
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        role: u.role,
        costCenterIds: parsePostgresArrayLiteral(u.cost_center_ids),
        vendorId: u.vendor_id ?? null,
      };
    } catch {
      throw new UnauthorizedException('invalid token');
    }
  }
}
