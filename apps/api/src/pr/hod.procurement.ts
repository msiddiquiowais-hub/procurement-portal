import type { DbService, SessionContext } from '../db/db.service';

/**
 * HOD PROCUREMENT — the one person who approves a comparative statement before
 * it advances toward the originating department's blind review.
 *
 * WHY THIS IS A DEPARTMENT LOOKUP AND NOT A ROLE STRING
 * ----------------------------------------------------
 * Every other HOD in this deployment signs in with the SAME role: `core.users.role
 * = 'hod'` for Finance, HR, IT, Operations and Sales alike. There is no
 * `hod_procurement` string to check, and inventing one would be a new
 * vocabulary the rest of the identity model does not use.
 *
 * So a role check cannot express this, and worse — `roleAllowed('hod', 'hod')` is
 * true for all five HODs, which would hand the Procurement sign-off to the Head
 * of Finance. That is the exact failure `requesterScope()` in
 * `CsReviewService` was written to avoid: its own comment says a role check
 * "would let ANY department manager open any PR's blind review, which is the
 * opposite of blind".
 *
 * Hence the same resolution the blind reviewer uses — an IDENTITY taken from the
 * department's own row, not a role string anyone carries:
 *
 *     core.departments.code = 'PROC'  ->  core.departments.hod_user_id
 *
 * Which also means this REFUSES by construction when no Procurement department
 * exists or has no HOD: nobody is entitled, rather than everybody who happens to
 * hold `hod`.
 */

/** The department code that identifies Procurement in `core.departments`. */
export const PROCUREMENT_DEPARTMENT_CODE = 'PROC';

/**
 * Is this user the Head of Procurement?
 *
 * Reads the department table rather than trusting a role, and refuses rather
 * than defaulting open. Returns false — never an exception — so a caller can
 * treat "nobody is the Procurement HOD" as a refusal and say so.
 */
export async function isHodProcurement(
  db: DbService,
  userId: string | null | undefined,
  ctx: SessionContext,
): Promise<boolean> {
  if (!userId) return false;
  const r = await db.query<{ is_hod_procurement: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM core.departments d
        WHERE upper(d.code) = upper($2)
          AND d.hod_user_id = $1::uuid
     ) AS is_hod_procurement`,
    [userId, PROCUREMENT_DEPARTMENT_CODE],
    ctx,
  );
  return r.rows[0]?.is_hod_procurement === true;
}

/**
 * Why the Procurement HOD gate refused, in the words the API should return.
 *
 * Split out so the same sentence appears on the classification card, the
 * re-apply action, the CS hand-off and the Step 5 -> Step 6 advance — a control
 * that reports three different reasons for the same refusal is one nobody can
 * act on.
 *
 * It names BOTH desks because every action that uses it is owned by Procurement:
 * the officer who ran the competition, and the head of the department. Writing
 * "HOD Procurement only" here while the code accepts `procurement` as well was
 * the kind of small lie that makes a refusal message disbelieved, and a refusal
 * nobody believes is a control nobody follows.
 */
export function hodProcurementRefusal(action: string): string {
  return (
    `${action} belongs to Procurement — the department's officer or its mapped head ` +
    `(core.departments.code = '${PROCUREMENT_DEPARTMENT_CODE}' -> hod_user_id). ` +
    'Procurement prepares the comparison, classifies the lines and advances the request; ' +
    'the head of the department approves it.'
  );
}