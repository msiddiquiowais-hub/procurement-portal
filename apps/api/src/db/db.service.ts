// DbService — executes SQL via `docker exec psql` instead of the node-pg
// driver. This is a workaround for the local-dev WSL/Docker host-TCP relay
// where direct pg connections from the host process get dropped.
//
// TRADE-OFFS:
//   - Each query spawns a process (~30-50ms overhead vs ~2ms pg).
//   - Only suitable for dev / smoke tests. Production should swap to pg.
//
// PUBLIC API (unchanged from the pg-based version):
//   query<T>(sql, params?, ctx?) -> { rows, rowCount }
//   withTransaction(ctx, fn)       -> result

import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';

export type QueryParams = any[];

export type SessionContext = {
  userId?: string;
  role?: string;
  costCenterIds?: string[];
  correlationId?: string;
  bypassRls?: boolean;
  /**
   * The caller's own department (core.users.department_id).
   *
   * Optional, and deliberately so: when it is absent the session resolves it
   * from the database instead. Resolution must not be the caller's job, because
   * a value passed in from a JWT or a form is a value that can be wrong, and
   * this one decides which department's records a head of department can read.
   */
  departmentId?: string;
  /**
   * RULE 5. Marks this statement as part of an audited vendor change.
   *
   * `core.fn_vendors_governed_change_gate()` refuses any UPDATE of a governed
   * vendor column (profile, categories, state, hold) unless this is set. Only
   * the vendor service sets it, and only for the two statements that make up a
   * change: the one appending the audit row, and the one that moves the vendor.
   * The database therefore cannot distinguish "the portal changed this" from
   * "someone ran raw SQL", and it never has to guess.
   */
  vendorChangeToken?: string;
};

@Injectable()
export class DbService {
  private readonly container = process.env.PG_CONTAINER || 'procurement-portal-db';
  private readonly user = process.env.DB_USER || 'proc';
  private readonly database = process.env.DB_NAME || 'procurementDB';

  async query<T = any>(
    text: string,
    params: QueryParams = [],
    ctx?: SessionContext,
  ): Promise<{ rows: T[]; rowCount: number }> {
    const wrapped = await this.wrap(text, params, ctx);
    const out = await this.runPsql(wrapped);
    return parsePsqlOutput<T>(out);
  }

  /** Run a function inside a transaction with the session context set.
   *  Note: each query inside `fn` is a separate docker-exec call wrapped in
   *  its own BEGIN/COMMIT, so this is NOT atomic in the strict DB sense.
   *  Acceptable for dev; production should use a real pg pool.
   */
  async withTransaction<T>(
    ctx: SessionContext | undefined,
    fn: (run: <U = any>(sql: string, params?: QueryParams) => Promise<{ rows: U[]; rowCount: number }>) => Promise<T>,
  ): Promise<T> {
    const run = async <U = any>(sql: string, params: QueryParams = []) => {
      // wrapWithContext already wraps in BEGIN/COMMIT — no extra needed.
      const wrapped = await this.wrap(sql, params, ctx);
      const out = await this.runPsql(wrapped);
      return parsePsqlOutput<U>(out);
    };
    return fn(run);
  }

  /**
   * Resolve the session's department once, then build the wrapped statement.
   *
   * `app.user_department_id` is what prs_visibility reads to scope a head of
   * department to their own department, and it is resolved from the ROW here
   * rather than passed in by the caller. Two reasons it cannot be trusted from
   * the caller: it is the one session value that decides which procurement
   * records someone may read, and every service method takes
   * (userId, role, costCenterIds) positionally — threading a fourth argument
   * through ~30 signatures is exactly the kind of change that gets half-done
   * and leaves a call site silently unscoped.
   *
   * Cached per userId for the process lifetime. A user's department changing
   * mid-session is an admin action, and the next API restart picks it up; the
   * alternative is an extra docker-exec round trip (~30-50ms) on every single
   * statement, which is the dominant cost of this already-slow transport.
   */
  private readonly deptCache = new Map<string, string | null>();

  private async wrap(sql: string, params: QueryParams, ctx?: SessionContext): Promise<string> {
    if (!ctx?.userId || ctx.bypassRls) return wrapWithContext(sql, params, ctx);
    if (!this.deptCache.has(ctx.userId)) {
      const r = await this.query<{ department_id: string | null }>(
        `SELECT department_id FROM core.users WHERE id = $1::uuid`,
        [ctx.userId],
        { bypassRls: true },
      );
      this.deptCache.set(ctx.userId, r.rows[0]?.department_id ?? null);
    }
    return wrapWithContext(sql, params, {
      ...ctx,
      departmentId: this.deptCache.get(ctx.userId) ?? undefined,
    });
  }

  private runPsql(sql: string): Promise<string> {
    if (process.env.SQL_TRACE === '1') {
      // eslint-disable-next-line no-console
      console.error('---SQL---\n' + sql + '\n---END---');
    }
    return new Promise((resolve, reject) => {
      const child = spawn(
        'docker',
        ['exec', '-i', this.container, 'psql',
         '-U', this.user,
         '-d', this.database,
         // CSV mode emits a header row so we can map columns to values.
         '--csv',
         '-X',
         '-q',
         '--no-psqlrc',
         '--set', 'ON_ERROR_STOP=on',
         '-v', 'ON_ERROR_STOP=1',
         '-f', '-',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => stdout += d.toString('utf8'));
      child.stderr.on('data', d => stderr += d.toString('utf8'));
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`psql exited ${code}: ${stderr || stdout}\nSQL was:\n${sql}`));
      });
      child.stdin.on('error', () => { /* ignore */ });
      child.stdin.write(sql);
      child.stdin.end();
    });
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function wrapWithContext(sql: string, params: QueryParams, ctx?: SessionContext): string {
  // Substitute $N params inline (safe-quoted).
  const substituted = sql.replace(/\$(\d+)/g, (_m, idxStr) => {
    const idx = parseInt(idxStr, 10) - 1;
    if (idx >= params.length) throw new Error(`missing param $${idxStr}`);
    return literalize(params[idx]);
  });

  // Ensure the user's SQL ends with a semicolon (required for psql -f).
  const trimmed = substituted.trimEnd();
  const withSemicolon = trimmed.endsWith(';') ? trimmed : trimmed + ';';

  // Wrap in a transaction so SET LOCAL affects only this scope.
  // After COMMIT/ROLLBACK, the session variables reset automatically.
  const setLines: string[] = [];
  if (ctx?.bypassRls) setLines.push(`SET LOCAL app.bypass_rls = 'true';`);
  else setLines.push(`SET LOCAL app.bypass_rls = 'false';`);
  if (ctx?.userId) setLines.push(`SET LOCAL app.current_user_id = '${escapeUuid(ctx.userId)}';`);
  else setLines.push(`SET LOCAL app.current_user_id = '';`);
  if (ctx?.role) setLines.push(`SET LOCAL app.user_role = '${escapeText(ctx.role)}';`);
  else setLines.push(`SET LOCAL app.user_role = '';`);
  if (ctx?.costCenterIds && ctx.costCenterIds.length) {
    setLines.push(`SET LOCAL app.user_cost_centers = '${ctx.costCenterIds.map(escapeUuid).join(',')}';`);
  } else {
    setLines.push(`SET LOCAL app.user_cost_centers = '';`);
  }
  // Which department the caller is in. prs_visibility scopes a head of
  // department to this, so it is set from the same place as the other session
  // identity values and is always present — a user with no department gets an
  // empty string, which matches no uuid and therefore scopes them to nothing.
  if (ctx?.departmentId) setLines.push(`SET LOCAL app.user_department_id = '${escapeUuid(ctx.departmentId)}';`);
  else setLines.push(`SET LOCAL app.user_department_id = '';`);
  if (ctx?.correlationId) setLines.push(`SET LOCAL app.correlation_id = '${escapeText(ctx.correlationId)}';`);
  else setLines.push(`SET LOCAL app.correlation_id = '';`);
  // Rule 5. Always set, so a statement that forgets to declare itself fails
  // closed inside the trigger rather than inheriting a value from elsewhere.
  setLines.push(
    `SET LOCAL app.vendor_change_token = '${ctx?.vendorChangeToken ? escapeText(ctx.vendorChangeToken) : ''}';`,
  );

  return `BEGIN;\n${setLines.join('\n')}\n${withSemicolon}\nCOMMIT;\n`;
}

function literalize(v: any): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v)) return arrayLiteral(v);
  return `'${escapeText(String(v))}'`;
}

/**
 * Postgres array literal.
 *
 * Elements inside `{...}` are NOT individually SQL-quoted — a single-quoted
 * element inside a brace literal is a syntax error, not a value. Each element
 * gets double-quoted with backslash escaping per the Postgres array grammar,
 * so `['A','B']` becomes `'{"A","B"}'`.
 */
function arrayLiteral(v: any[]): string {
  const parts = v.map(el => {
    if (el === null || el === undefined) return 'NULL';
    if (typeof el === 'number' && Number.isFinite(el)) return String(el);
    if (typeof el === 'boolean') return el ? 'true' : 'false';
    const s = String(el).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${s}"`;
  });
  return `'{${parts.join(',')}}'`;
}

function escapeText(s: string) {
  return s.replace(/'/g, "''");
}

function escapeUuid(s: string) {
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw new Error('invalid uuid: ' + s);
  return s;
}

function parsePsqlOutput<T = any>(stdout: string): { rows: T[]; rowCount: number } {
  // psql --csv emits a header row, then one data row per line. Cells are
  // comma-separated; embedded commas/quotes are RFC-4180 escaped (dquote).
  // psql emits boolean values as the literal strings "t" / "f" — we coerce
  // them to JS booleans so callers don't have to remember to compare strings.
  let text = stdout.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (!text) return { rows: [], rowCount: 0 };
  const lines = text.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) return { rows: [], rowCount: 0 };
  const header = parseCsvLine(lines[0]);
  const dataLines = lines.slice(1);
  const rows: T[] = dataLines.map(line => {
    const cells = parseCsvLine(line);
    const row: Record<string, any> = {};
    for (let i = 0; i < header.length; i++) {
      const v = cells[i];
      if (v === undefined || v === 'NULL' || v === '') {
        row[header[i]] = null;
      } else if (v === 't') {
        row[header[i]] = true;
      } else if (v === 'f') {
        row[header[i]] = false;
      } else {
        row[header[i]] = v;
      }
    }
    return row as unknown as T;
  });
  return { rows, rowCount: rows.length };
}

/** Minimal RFC-4180 CSV line parser (single-line input). Supports quoted
 *  fields with embedded commas and doubled-quote escapes. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"' && cur.length === 0) inQuotes = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}
