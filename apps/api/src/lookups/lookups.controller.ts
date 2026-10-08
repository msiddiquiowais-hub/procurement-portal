import { Controller, Get, UseGuards } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

@UseGuards(JwtAuthGuard)
@Controller('lookups')
export class LookupsController {
  constructor(private readonly db: DbService) {}

  @Get('cost-centers')
  async costCenters() {
    // department_id is REQUIRED by the client: a PR's department is derived
    // server-side from cost_center_id, so the form must be able to resolve
    // "which cost centre belongs to department X" to send the right one.
    // Without this column the client can only guess, and guessing picks
    // whatever row happens to sort first (Lahore Sales).
    const r = await this.db.query(
      `SELECT id, code, name, hod_user_id, department_id
         FROM core.cost_centers WHERE active = true ORDER BY code`,
      [],
      { bypassRls: true },
    );
    return r.rows;
  }

  @Get('items')
  async items() {
    const r = await this.db.query(
      `SELECT id, item_code, name, category, uom, expense_type, gl_account
         FROM core.items WHERE active = true ORDER BY item_code`,
      [],
      { bypassRls: true },
    );
    return r.rows;
  }

  /**
   * Line categories, with BOTH the name and the description.
   *
   * Reads core.categories rather than `SELECT DISTINCT category FROM
   * core.items`, and the distinction matters: items only carry four of the nine
   * categories, and the four they carry are not the ones the approval rules
   * branch on. workflow.steps_config 'hod_review' routes IT_HARDWARE and
   * IT_SOFTWARE (over PKR 100,000 to the IT Manager) and OFFICE_SUPPLIES and
   * WAREHOUSE_ACCESSORY (to Warehouse). Deriving the dropdown from items would
   * have hidden IT_SOFTWARE and MACHINERY, making that routing unreachable
   * from the form.
   *
   * Only ACTIVE categories are returned, and the code is what the client must
   * send back: proc.pr_lines.category carries a foreign key to this table, so
   * the database rejects anything not listed here.
   */
  @Get('categories')
  async categories() {
    const r = await this.db.query(
      `SELECT code, name, description
         FROM core.categories
        WHERE active = true
        ORDER BY name`,
      [],
      { bypassRls: true },
    );
    return r.rows;
  }

  @Get('uoms')
  async uoms() {
    // The create form used to carry a hardcoded 10-entry UOM array. It offered
    // 10 of the 19 codes core.uom actually defines, so a requester picking the
    // wrong thing got a foreign-key failure from proc.pr_lines.uom (migration
    // 034) naming a constraint instead of saying "pick one of these".
    const r = await this.db.query(
      `SELECT code, name FROM core.uom ORDER BY code`,
      [],
      { bypassRls: true },
    );
    return r.rows;
  }

  @Get('departments')
  async departments() {
    const r = await this.db.query(
      `SELECT id, code, name, hod_user_id FROM core.departments WHERE active = true ORDER BY code`,
      [],
      { bypassRls: true },
    );
    return r.rows;
  }
}
