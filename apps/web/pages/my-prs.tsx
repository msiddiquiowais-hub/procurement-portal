// `my-prs` — My Purchase Requisitions.
//
// Port of renderMyPRs (prototype line 8059), reduced to the lightweight
// request table. The prototype's first table ("Detailed flow" — the capital
// requisition) is no longer shown here; capital PRs stay reachable through
// the New PR / New Purchase Requisition entry points and their own detail
// screens, they are just not listed on this page.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from '../lib/session';
import {
  SOURCING_TABS as TABS,
  rowsForTab,
  type SourcingTabKey,
} from '../components/sourcing/tabs';
import { api } from '../lib/api';
import Shell from '../components/Shell';
import { StagePill, DeptChip, pkr, fmtDate } from '../lib/ui';
import { canSeeScreen } from '@procurement/roles';

type Light = {
  id: string; pr_number: string; title: string | null; description: string | null;
  estimated_amount: number; urgency: string; status: string;
  department_name: string; item_count: number;
  first_qty: number | null; first_uom: string | null;
  last_updated_at: string;
  // Sourcing status — derived by the API on every read, never stored.
  //
  // The first five are the post-RFQ governance lifecycle. They exist so this
  // column carries PROGRESS while STAGE carries the DEPARTMENT holding the PR:
  // a PR at PACK_LOCKED reads STAGE "CS review", STATUS "Pack locked". Before
  // the split, that same row showed the words "Pack locked" in the STAGE column
  // and a red "Expired" pill in this one, because the deadline had passed.
  sourcing_status: string;
  rfq_number: string | null;
  invited_vendors: number;
  responded_vendors: number;
  submitted_vendors: number;
  awaiting_vendors: number;
  expired_vendor_count: number;
  reissue_count: number;
  rfq_overdue: boolean;
  // The CS review sub-state, as a PARALLEL column rather than more
  // sourcing_status values. components/sourcing/tabs.ts pins
  // QUOTES_RECEIVED into the Received tab with a written rationale that
  // tests/sourcing-tabs.test.ts asserts, so splitting that value into five
  // would silently empty a chip. Since migration 075 the split is safe anyway:
  // that tab now filters on the request's real `status` rather than on this
  // column, so the two no longer share an owner.
  //
  // Null everywhere except inside the CS review window. It used to also report
  // COST_APPROVAL_PENDING for the stage after the exit; that stage is gone from
  // the ladder, and the exit now lands on Finance review, which is a stage
  // question answered by the STAGE column.
  cs_progress: string | null;
};

/**
 * The CS review sub-state, rendered by STATUS when the API reports one.
 *
 * Requirement: while the engine stage is CS review (QUOTES_RECEIVED) the
 * STATUS column must resolve the live sub-state from proc.cs_reviews rather
 * than freezing at one identical pill — otherwise every PR in that window reads
 * the same whether the statement is an untouched draft or confirmed and waiting
 * for procurement to classify the lines.
 *
 * Deliberately absent: a "ready to advance" label. A confirmed statement has
 * exactly ONE outstanding action (the card's "Save & Proceed to Finance
 * Review"), so a passive status inviting a second, separate click would be a
 * second door into the same gate.
 */
const CS_PROGRESS_LABELS: Record<string, { cls: string; label: string; hint: string }> = {
  CS_DRAFT: {
    cls: 'draft',
    label: 'CS Draft',
    hint: 'A comparative statement exists but has not been submitted for review',
  },
  CS_PROC_REVIEW: {
    cls: 'submitted',
    label: 'CS In Review',
    hint: 'On procurement’s desk — being checked',
  },
  CS_AWAITING_HOD: {
    cls: 'pending',
    label: 'Awaiting HOD Confirm',
    hint: 'Submitted — back with the requesting HOD for confirmation',
  },
  CS_CONFIRMED_CLASSIFY: {
    cls: 'approved',
    label: 'CS Confirmed / Classify Lines',
    hint: 'Review confirmed — procurement must classify every approved line',
  },
  CS_REVERTED: {
    // Red on purpose: a reverted statement is not progress and not neutral. It
    // is the one sub-state where a document went BACKWARDS, and the pill should
    // say so rather than wearing the same amber as a healthy in-flight one.
    cls: 'rejected',
    label: 'CS Reverted',
    hint: 'The HOD sent this statement back for correction',
  },
};

/**
 * Sourcing status pill + re-issue chip.
 *
 * Split into its own component because the two things it renders are NOT
 * mutually exclusive: a re-issued RFQ is simultaneously "Re-issued x1" and
 * "Awaiting Quotes (3/5)". Collapsing them into one enum would throw away the
 * live quote progress on exactly the PRs that most need chasing.
 *
 * Tone classes come from the prototype's own RFQ palette in globals.css
 * (.draft / .submitted / .pending / .approved / .rejected) rather than a new set.
 * Awaiting-quotes deliberately reuses `submitted` (#DBEAFE/#1E40AF) because that
 * is the exact colour the prototype paints its "RFQ issued, awaiting quotes"
 * pill (prototype line 6082).
 */
function SourcingCell({ p }: { p: Light }) {
  const s = p.sourcing_status;

  // A PR that has not reached procurement yet is not late issuing an RFQ.
  // An em-dash is the honest cell: "nothing to say", not "not issued". The
  // prototype's own convention for an inapplicable value.
  if (s === 'PRE_PROCUREMENT') {
    return <span className="text-mute" title="Sourcing has not started — this PR has not reached procurement review">—</span>;
  }

  // A PR past the delay limit with no RFQ is the fraud signal: turn the pill red
  // rather than adding a second visual, so the eye lands in one place.
  const overdue = p.rfq_overdue && s === 'NOT_ISSUED';

  const pill: { cls: string; label: string; hint?: string } = (() => {
    // The CS sub-state WINS over sourcing progress whenever the API reports
    // one. It is a strictly more specific answer to the same question — and
    // inside the CS window it is the only answer that changes from hour to
    // hour as the statement moves between desks. Falling through to the switch
    // below would render all five sub-states as the same sourcing pill, which
    // is precisely the freeze the requirement forbids.
    if (p.cs_progress && CS_PROGRESS_LABELS[p.cs_progress]) {
      return CS_PROGRESS_LABELS[p.cs_progress];
    }
    if (overdue) return { cls: 'rejected', label: 'RFQ overdue' };
    switch (s) {
      // Sourcing is over and the quote window is historical. One value, not
      // five — migration 075 stopped this column naming workflow stages, so the
      // STAGE column is the only place that says WHICH stage it ended on, and
      // this one says only that it ended.
      //
      // `draft` (grey) rather than `pending` (amber): a concluded round is
      // neither a problem nor an achievement. Amber is the colour of "something
      // is outstanding", and 189 finished requests wearing it put a warning on
      // work nobody can act on — which is the same crying-wolf the EXPIRED branch
      // was written to stop, one tone down.
      case 'SOURCING_CLOSED':
        return { cls: 'draft', label: 'Sourcing closed' };
      case 'NOT_ISSUED':
        return { cls: 'draft', label: 'RFQ not issued' };
      case 'AWAITING_QUOTES':
        // An RFQ with zero invitations has been created but never dispatched.
        // "0/0" would read as a division bug, so it says what actually happened.
        return p.invited_vendors === 0
          ? { cls: 'draft', label: 'Not dispatched' }
          : { cls: 'submitted', label: `Awaiting Quotes (${p.responded_vendors}/${p.invited_vendors})` };
      case 'RECEIVED':
        return { cls: 'approved', label: `Received (${p.responded_vendors}/${p.invited_vendors})` };
      case 'RECEIVED_THRESHOLD_MET':
        return { cls: 'pending', label: `Received (threshold met) ${p.responded_vendors}/${p.invited_vendors}` };
      case 'EXPIRED':
        return { cls: 'rejected', label: `Expired (${p.responded_vendors}/${p.invited_vendors})` };
      default:
        return { cls: '', label: s };
    }
  })();

  // Vendor-level expiry survives a PR that cleared the threshold: those vendors
  // are still the ones management needs to look at. The SQL derives it
  // INDEPENDENTLY of the PR-level state for the same reason, so the chip has to
  // cover the settled states too — a vendor that went silent before the deadline
  // is the thing an audit looks for, and it matters MORE on a PR that has been
  // awarded than on one still in play. Restricting this to the two RECEIVED
  // states would have hidden exactly the population it was written for.
  const silent =
    p.expired_vendor_count > 0 &&
    (s === 'RECEIVED' || s === 'RECEIVED_THRESHOLD_MET' ||
     s === 'QUOTES_RECEIVED' || s === 'CS_LOCKED' || s === 'MC_APPROVED' ||
     s === 'CFO_APPROVED' || s === 'PACK_LOCKED');

  return (
    <div className="sourcing-cell">
      <span className={`pill ${pill.cls}`} title={pill.hint}>{pill.label}</span>
      {p.reissue_count > 0 && (
        <span className="chip-reissued" title={`Re-issued ${p.reissue_count}x — vendors were added after the first issue`}>
          Re-issued ×{p.reissue_count}
        </span>
      )}
      {silent && (
        <span className="chip-silent" title={`${p.expired_vendor_count} invited vendor(s) never responded before the deadline`}>
          {p.expired_vendor_count} silent
        </span>
      )}
    </div>
  );
}

/**
 * The action tabs above the grid.
 *
 * Filtering is a pure predicate over the rows already in memory — no refetch, no
 * query string, no panel. That is the whole point of the requirement: the grid is
 * already loaded, and re-requesting it to change which rows are visible would be
 * a page reload wearing a costume.
 *
 * The rules themselves live in components/sourcing/tabs.ts so they can be
 * unit-tested against synthetic rows — the Expired tab is empty in the current
 * 200-row window, so a browser-only check would never exercise it.
 */
const SOURCING_TABS = TABS;
type TabKey = SourcingTabKey;

export default function MyPrs() {
  const { session, ready } = useSession();
  const router = useRouter();
  const [light, setLight] = useState<Light[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('all');

  useEffect(() => {
    if (!ready) return;                 // session not read from storage yet
    if (!session) { router.replace('/'); return; }
    api.get<{ detailed: unknown[]; light: Light[] }>('/pr/capital/my')
      .then(r => setLight(r.data.light || []))
      .catch(e => setErr(e.message));
  }, [ready, session]);

  if (!ready) return null;
  if (!session) return null;
  const role = session.user.role;
  const canCreate = canSeeScreen(role, 'pr-create');

  const active = SOURCING_TABS.find(t => t.key === tab) ?? SOURCING_TABS[0];
  // Recomputed on render, not stored: a second copy of "which rows are visible"
  // is a second thing that can drift from the rows themselves.
  const rows = rowsForTab(light, tab);

  return (
    <Shell title="My Purchase Requisitions" screenId="my-prs"
      subtitle="The lightweight purchase requests you have raised.">
      {err && <div className="alert error">{err}</div>}

      {canCreate && (
        <div className="btn-row" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
          <Link href="/pr/create" className="btn success">+ New Purchase Requisition</Link>
          <Link href="/pr/new" className="btn">New Lightweight Request</Link>
        </div>
      )}

      {/* ── Lightweight PRs ─────────────────────────────────────────── */}
      <div className="card">
        <div className="card-h">
          <h3>Lightweight PRs</h3>
          <span className="meta">
            {active.key === 'all'
              ? `${light.length} requests`
              : `${rows.length} of ${light.length} · ${active.label}`}
          </span>
        </div>

        {/* ── Action tabs. In-place: buttons, not links, and no refetch. ── */}
        {light.length > 0 && (
          <div className="tab-row" role="tablist" aria-label="Filter by sourcing status">
            {SOURCING_TABS.map(t => {
              const n = light.filter(t.match).length;
              const on = t.key === active.key;
              return (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={on}
                  className={`tab${on ? ' active' : ''}${n === 0 && !on ? ' empty' : ''}`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                  <span className="tab-count">{n}</span>
                </button>
              );
            })}
          </div>
        )}

        {light.length === 0 ? (
          <div className="card-b empty-state">No lightweight requests yet.</div>
        ) : rows.length === 0 ? (
          <div className="card-b empty-state">
            No requests match <b>{active.label}</b>.
          </div>
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th>PR Number</th><th>Description</th><th>Dept</th>
                <th>Qty × UoM</th><th className="num">Est. Amount</th>
                <th>Priority</th><th>Stage</th><th>Status</th><th>Flow</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => (
                <tr key={p.id} className="clickable" onClick={() => router.push(`/pr/${p.id}`)}>
                  <td className="mono">{p.pr_number}</td>
                  <td>
                    <div className="row-title">{p.title || p.description || '—'}</div>
                    {p.title && p.description && <div className="row-sub">{p.description}</div>}
                  </td>
                  <td><DeptChip name={p.department_name} /></td>
                  <td className="text-sm">
                    {p.first_qty !== null ? `${p.first_qty} ${p.first_uom || ''}` : '—'}
                    {p.item_count > 1 && <span className="text-mute"> +{p.item_count - 1}</span>}
                  </td>
                  <td className="mono num">{pkr(p.estimated_amount)}</td>
                  <td>
                    <span className={p.urgency === 'urgent' ? 'urgency-urgent' : p.urgency === 'force_majeure' ? 'urgency-force_majeure' : 'text-sm text-mute'}>
                      {p.urgency === 'routine' ? 'NORMAL' : p.urgency.toUpperCase()}
                    </span>
                  </td>
                  <td><StagePill stage={p.status} /></td>
                  <td><SourcingCell p={p} /></td>
                  <td className="text-sm text-mute">{fmtDate(p.last_updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
