// Shared: make an RFQ roster reach a target size, for e2e fixtures.
//
// WHY THIS EXISTS
// ---------------
// The automatic roster on POST /pr/:id/rfq is CATEGORY-matched and risk-filtered,
// so it is legitimately shorter than the prototype's fixed three. A laptop
// fixture resolves to the two IT_HARDWARE vendors that are not High-risk.
//
// Fixtures used to do `for (let i = 0; i < 3; i++) invites[i]` and assumed
// three vendors, which was true when the pool was category-blind ("any
// categorised vendor, top 3 by vendor_code") and quietly stopped being true once
// the pool honoured the PR's line categories. The symptom was
// `Cannot read properties of undefined (reading 'vendor_id')` — an IndexError
// wearing a TypeError, pointing at the fixture rather than at the thing that
// changed.
//
// Topping up goes through POST /rfq/:id/invite, which is the supported path and
// exactly what the API's own shortfall warning tells an operator to do. So this
// helper exercises real product behaviour instead of reaching around it with
// psql.

import { spawnSync } from 'node:child_process';

const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';

function psql(sql) {
  const r = spawnSync(
    'docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'proc',
               '-d', 'procurementDB', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { input: `SET app.bypass_rls = 'true';\n${sql}`, encoding: 'utf8' },
  );
  return `${r.stdout || ''}${r.stderr || ''}`.trim();
}

/** Eligible vendors not already on this RFQ's roster. */
function spareVendors(excludeIds, need) {
  const excluded = excludeIds.map(id => `'${id}'`).join(',') || `''`;
  return psql(
    `SELECT id::text FROM core.vendors
      WHERE state <> ALL(ARRAY['Rejected','Blacklisted','Deactivated'])
        AND NOT is_hold
        AND id::text <> ALL(ARRAY[${excluded}])
      ORDER BY vendor_code LIMIT ${need};`)
    .split('\n').map(s => s.trim()).filter(Boolean);
}

/**
 * Issue an RFQ for `prId` and return a roster of at least `target` vendors.
 *
 * @param api      the harness's api(path, {method,token,body})
 * @param proc     procurement token — issuing and quoting both require it
 * @param prId
 * @param target   minimum roster size (the prototype's is 3)
 */
export async function issueWithRoster(api, proc, prId, target = 3) {
  const issued = await api(`/pr/${prId}/rfq`, { method: 'POST', token: proc, body: {} });
  if (issued.status >= 400) {
    throw new Error(`RFQ issue failed (${issued.status}): ${JSON.stringify(issued.data)}`);
  }
  const rfqId = issued.data.rfq.id;
  let invites = issued.data.invitations || [];

  if (invites.length < target) {
    for (const vendorId of spareVendors(invites.map(i => i.vendor_id), target - invites.length)) {
      const r = await api(`/rfq/${rfqId}/invite`, {
        method: 'POST', token: proc, body: { vendorId },
      });
      if (r.status >= 400) {
        throw new Error(`invite failed (${r.status}): ${JSON.stringify(r.data)}`);
      }
    }
    const re = await api(`/rfq/${rfqId}`, { token: proc });
    invites = (re.data?.roster || []).map(x => ({ vendor_id: x.vendor_id }));
  }

  if (invites.length < target) {
    throw new Error(
      `could only build a ${invites.length}-vendor roster (wanted ${target}); ` +
      'there are not enough eligible vendors in the master to test a ' +
      `${target}-quote competition`);
  }
  return { rfqId, invites, issued: issued.data };
}