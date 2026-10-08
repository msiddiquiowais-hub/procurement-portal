// The two widgets that EVERY governance screen renders.
//
// All five Wave 3 screens call `purposeAndAckWidget(pr)` and
// `imageGalleryCard(pr,'viewer')` (prototype lines 7883-7884, 7911-7912,
// 7935-7936, 8003-8004, 8033-8034). They are shared components rather than five
// copies because a fix to the acknowledgement logic has to land in one place —
// the prototype gets that for free by calling a function, and so do we.
//
// Both render NOTHING when the PR has no purchase purpose or no images, which
// is the prototype's behaviour (line 1597: `if(!p || !p.purposeType) return ''`).
// An empty card saying "no purpose" would be a card the prototype never shows.

import { fmtDate, fmtDateTime, initials } from '../../lib/ui';

// ─── purposeAndAckWidget — prototype line 1595 ──────────────────────────────

export type AckApprover = {
  id?: string;
  name: string | null;
  email: string | null;
  role: string | null;
  role_label?: string | null;
  acknowledged: boolean;
  acknowledged_at: string | null;
};

export type PurposeAck = {
  purpose_type: string | null;
  summary: string | null;
  approvers: AckApprover[];
  total: number;
  pending: number;
  /** A board or a CFO should not have to open the PR to see who is holding it up. */
  showNote?: boolean;
};

/** The prototype's purposePill() (line 1538) — the four scenario colours. */
const PURPOSE_PILL: Record<string, { label: string; style: React.CSSProperties }> = {
  EXISTING_EMPLOYEE: {
    label: 'Existing Employee',
    style: { background: '#E0F2FE', color: '#075985', border: '1px solid #BAE6FD' },
  },
  NEW_EMPLOYEE: {
    label: 'New Employee',
    style: { background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A' },
  },
  BACKUP: {
    label: 'Backup / Spare',
    style: { background: '#DBEAFE', color: '#1E3A8A', border: '1px solid #BFDBFE' },
  },
  NEW_PROJECT: {
    label: 'New Project',
    style: { background: '#EDE9FE', color: '#5B21B6', border: '1px solid #DDD6FE' },
  },
};

/** The prototype's ackPill() (line 1545). */
function AckPill({ a }: { a: AckApprover }) {
  if (a.acknowledged) {
    return (
      <span
        className="pill"
        style={{ background: '#D1FAE5', color: '#065F46', border: '1px solid #A7F3D0' }}
      >
        ✓ Acknowledged {a.acknowledged_at || ''}
      </span>
    );
  }
  return (
    <span
      className="pill"
      style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A' }}
    >
      ⏳ Awaiting ack
    </span>
  );
}

/** The prototype's ackSummaryChip() (line 1586). */
function SummaryChip({ total, pending }: { total: number; pending: number }) {
  if (total === 0) {
    return <span className="pill" style={{ background: 'var(--line-soft)', color: 'var(--text-2)' }}>No approvers tagged</span>;
  }
  if (pending === 0) {
    return <span className="pill" style={{ background: '#D1FAE5', color: '#065F46', border: '1px solid #A7F3D0' }}>All {total} acknowledgers done</span>;
  }
  return <span className="pill" style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A' }}>{pending} of {total} pending acknowledgement</span>;
}

export function PurposeAckWidget({ data }: { data: PurposeAck | null | undefined }) {
  if (!data || !data.purpose_type) return null;
  const pill = PURPOSE_PILL[data.purpose_type];
  const approvers = data.approvers || [];
  const shown = approvers.slice(0, 6);
  const more = approvers.length - shown.length;

  return (
    <div className="card mb-4">
      <div className="card-h">
        <h3>Purchase purpose &amp; acknowledgements</h3>
        <span className="meta"><SummaryChip total={data.total} pending={data.pending} /></span>
      </div>
      <div className="card-b">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <b>Scenario:</b>{' '}
          <span className="pill" style={pill?.style}>{pill?.label || data.purpose_type}</span>
        </div>
        {data.summary && (
          <div className="text-sm" style={{ marginBottom: 12, lineHeight: 1.5 }}>{data.summary}</div>
        )}
        <div
          className="text-sm"
          style={{ fontWeight: 600, color: 'var(--text-mute)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.04em', fontSize: 10 }}
        >
          Tagged approvers ({approvers.length})
        </div>
        {shown.map((a, i) => (
          <div key={a.id || a.email || i} className="approver-row" style={{ padding: '6px 8px' }}>
            <div className="avatar" style={{ width: 22, height: 22, fontSize: 9 }}>{initials(a.name)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{a.name || '(unnamed)'}</div>
              <div className="text-sm text-mute" style={{ fontSize: 11 }}>{a.email || ''}</div>
            </div>
            <div className="ack-status"><AckPill a={a} /></div>
          </div>
        ))}
        {more > 0 && <div className="text-sm text-mute" style={{ marginTop: 4 }}>+{more} more...</div>}
        {/* The prototype's SOFT gate (line 1614-1616). Note what it says: the PR
            keeps moving. Acknowledgement is visibility, not a blocking gate. */}
        {data.pending > 0 ? (
          <div className="alert warn" style={{ marginTop: 10, marginBottom: 0 }}>
            <b>Soft gate:</b> PR keeps moving; tagged approvers receive an email with a unique{' '}
            <span className="ack-deep-link">#ack=&lt;token&gt;</span> link. {data.pending} still pending.
          </div>
        ) : (
          <div className="alert success" style={{ marginTop: 10, marginBottom: 0 }}>
            <b>All acknowledgements complete.</b> Audit log shows acceptance timestamps.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── imageGalleryCard — prototype line 9763, viewer mode ───────────────────

export type RefImage = {
  id: string;
  line_id: string | null;
  caption: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sort_order: number;
  uploaded_at: string | null;
  url?: string | null;
};

export function ImageGalleryCard({ images }: { images: RefImage[] | null | undefined }) {
  const list = images || [];
  const totalKb = list.reduce((n, i) => n + Number(i.size_bytes || 0), 0) / 1024;
  // The prototype's own copy for a read-only gallery (line 9786).
  const viewer = list.length
    ? 'Reference pictures uploaded by the requester. Click a thumbnail to enlarge.'
    : 'No reference pictures were attached to this purchase request.';

  return (
    <div className="card mb-4 image-gallery-card">
      <div className="card-h">
        <h3>Reference pictures</h3>
        <span className="meta">
          <span className="image-count-chip">{list.length} pictures</span> &middot;{' '}
          <span className="image-total-chip">{totalKb < 1 ? '0 KB' : `${totalKb.toFixed(0)} KB`}</span>
        </span>
      </div>
      <div className="card-b">
        <div className="text-sm text-mute" style={{ marginBottom: 10 }}>{viewer}</div>
        <div
          className="image-thumb-grid"
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 10 }}
        >
          {list.map((im) => (
            <div key={im.id} style={{ border: '1px solid var(--line-soft)', borderRadius: 8, padding: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{im.caption || 'Reference picture'}</div>
              <div className="text-sm text-mute" style={{ fontSize: 11 }}>
                {im.mime_type || '—'}
                {im.size_bytes ? ` · ${(Number(im.size_bytes) / 1024).toFixed(0)} KB` : ''}
              </div>
              {im.uploaded_at ? (
                <div className="text-sm text-mute" style={{ fontSize: 11 }}>
                  {fmtDate(im.uploaded_at)}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── the three bespoke governance cards ────────────────────────────────────

/** McVoteTable — renderMCVote's table (prototype line 7876-7882). */
export type McPanelRow = {
  user_id: string;
  name: string;
  email: string;
  seat: number;
  chair: boolean;
  vote: 'approve' | 'reject' | null;
  note: string;
  reason: string | null;
};

export function McVoteTable({
  panel, tally,
}: {
  panel: McPanelRow[];
  tally: { text: string; approves: number; rejects: number };
}) {
  return (
    <div className="card mb-4">
      <div className="card-h">
        <h3>Members &amp; votes</h3>
        <span className="meta">{tally.text}</span>
      </div>
      <table className="t">
        <thead>
          <tr><th>Member</th><th>Vote</th><th>Note</th></tr>
        </thead>
        <tbody>
          {panel.map((p) => (
            <tr key={p.user_id}>
              <td>
                <b>{p.name}</b>
                {p.chair && <span className="role-tag">Chair</span>}
                <div className="text-sm text-mute">{p.email}</div>
                {p.reason && <div className="text-sm text-mute" style={{ fontStyle: 'italic' }}>&ldquo;{p.reason}&rdquo;</div>}
              </td>
              <td>
                {p.vote === 'approve'
                  ? <span className="pill approved">Approve</span>
                  : p.vote === 'reject'
                    ? <span className="pill rejected">Reject</span>
                    : <span className="pill draft">Pending</span>}
              </td>
              <td className="text-sm text-mute">{p.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** PackDocuments — renderPack's six-row hash table (prototype line 7944-7947). */
export type PackDoc = {
  name: string;
  state: 'present' | 'skipped' | 'missing';
  sha256: string | null;
  display_hash: string;
  source: string | null;
  note?: string;
};

export function PackDocuments({ documents }: { documents: PackDoc[] }) {
  return (
    <div className="card mb-4">
      <div className="card-h">
        <h3>Pack documents ({documents.length})</h3>
        <span className="meta">
          {documents.filter((d) => d.state === 'present').length} hashed
        </span>
      </div>
      <table className="t">
        <thead>
          <tr><th>#</th><th>Document</th><th>SHA-256</th><th>Signed</th></tr>
        </thead>
        <tbody>
          {documents.map((d, i) => (
            <tr key={d.name}>
              <td>{i + 1}</td>
              <td>
                {d.name}
                {/* D1 + F2: a document with no real digest says WHY. A blank
                    hash cell next to an approval that never happened is the
                    exact thing F2 exists to prevent. */}
                {d.state !== 'present' && (
                  <div className="text-sm text-mute" style={{ fontStyle: 'italic' }}>{d.note}</div>
                )}
              </td>
              <td className="mono text-sm">
                {d.state === 'present'
                  ? <span title={d.sha256 || undefined}>{d.display_hash}</span>
                  : <span className="text-mute" title="No real digest exists for this document">&mdash;</span>}
              </td>
              <td>
                {d.state === 'present'
                  ? <span className="pill approved">✓</span>
                  : <span className="text-mute" title={d.note}>—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** D365EventStream — renderD365Status's six rows (prototype line 8054-8055). */
export type D365Event = {
  key: string;
  ts: string;
  action: string;
  detail: string;
  state: 'done' | 'pending';
  reachedAt: string | null;
};

export function D365EventStream({ events }: { events: D365Event[] }) {
  return (
    <div className="card">
      <div className="card-h"><h3>D365 event stream</h3></div>
      <div className="card-b">
        {events.map((e) => (
          <div key={e.key} className="event-row">
            <div
              className="event-dot"
              style={{ background: e.state === 'done' ? 'var(--success)' : 'var(--line)' }}
            />
            <div style={{ flex: 1 }}>
              <div><b>{e.action}</b> &middot; <span className="text-mute">{e.detail}</span></div>
              <div className="event-meta">
                {e.state === 'done' && e.reachedAt ? fmtDateTime(e.reachedAt) : e.ts}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** CfoSummaryGrid — renderCFO's seven-row kv block (prototype line 7901-7910). */
export type CfoRow = { key: string; label: string; value: string; unknown?: boolean };

export function CfoSummaryGrid({ rows }: { rows: CfoRow[] }) {
  return (
    <div className="card mb-4">
      <div className="card-h"><h3>Pack summary</h3></div>
      <div className="card-b">
        <div className="kv">
          {rows.map((r) => (
            <div key={r.key} style={{ display: 'contents' }}>
              <div className="k">{r.label}</div>
              <div className="v">
                {/* F1: an underivable value is an em-dash with a tooltip saying
                    why, never a plausible-looking substitution. */}
                <span title={r.unknown ? 'This value could not be derived from the record.' : undefined}>
                  {r.value}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
