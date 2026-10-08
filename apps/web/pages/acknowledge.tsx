// `acknowledge` — Acknowledgement requests.
//
// Port of renderAcknowledge (prototype line 9716). Structure preserved:
// title + the prototype's PR_ACK_SUBTITLE copy, an optional deep-link banner
// resolved from `#ack=<token>`, the "Tagged approvers — N pending of M" card
// with the prototype's ackSummaryChip + per-row ackPill, a PR-context card, and
// the "Why am I being asked?" fraud-control card.
//
// The prototype's image gallery is omitted: the data exists (GET /pr/:id
// returns images[]) but the storage adapter is still a prototype concern.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from '../lib/session';
import { api } from '../lib/api';
import Shell from '../components/Shell';
import { StagePill, DeptChip, pkr, fmtDateTime, initials } from '../lib/ui';

// Verbatim from the prototype's PR_ACK_SUBTITLE (line 9938).
const PR_ACK_SUBTITLE =
  'Email-link recipients land here to acknowledge the PR they were tagged on. The main ' +
  'procurement flow does not pause for this — your acceptance is a permanent fraud-control record.';

const ROLE_LABEL: Record<string, string> = {
  employee: 'Employee',
  dept_head: 'Dept Head',
  director: 'Director',
  project_lead: 'Project Lead',
  requester_self: 'Requester',
  new_employee: 'New Employee',
};

const DEFAULT_TAGGED: Array<{ taggedRole: string; name: string; email: string; deptCode?: string }> = [
  { taggedRole: 'employee', name: '', email: '' },
  { taggedRole: 'dept_head', name: '', email: '', deptCode: '' },
];

type Approver = {
  id: string; tagged_role: string; name: string; email: string;
  token: string; acknowledged: boolean; acknowledged_at: string | null; tagged_at: string;
};

type Request = {
  pr_id: string; pr_number: string; title: string | null; status: string;
  estimated_amount: number; currency: string; requester_name: string;
  department_name: string; created_at: string;
  approvers: Approver[]; total: number; pending: number; acked: number;
  summary: { tone: string; label: string };
};

export default function Acknowledge() {
  const { session, ready } = useSession();
  const router = useRouter();

  const [requests, setRequests] = useState<Request[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: string; text: string } | null>(null);

  // Deep link: /acknowledge#ack=<token> (mirrors the prototype's hash link).
  const [tokenApprover, setTokenApprover] = useState<any>(null);
  const [draft, setDraft] = useState(DEFAULT_TAGGED);

  const load = useCallback(() => {
    api.get<{ requests: Request[] }>('/ack')
      .then(r => setRequests(r.data.requests || []))
      .catch(e => setErr(e.message));
  }, []);

  useEffect(() => {
    if (!ready) return;                 // session not read from storage yet
    if (!session) { router.replace('/'); return; }
    load();
    const readHash = () => {
      const h = window.location.hash || '';
      if (!h.startsWith('#ack=')) { setTokenApprover(null); return; }
      const token = h.slice(5);
      api.get<{ approver: any }>(`/ack/resolve/${encodeURIComponent(token)}`)
        .then(r => setTokenApprover(r.data.approver))
        .catch(() => setTokenApprover({ invalid: true, token }));
    };
    readHash();
    window.addEventListener('hashchange', readHash);
    return () => window.removeEventListener('hashchange', readHash);
  }, [ready, session, load]);

  if (!ready) return null;
  if (!session) return null;

  async function accept(token: string) {
    setBusy(token); setErr(null);
    try {
      // Sent without the auth header on purpose: the emailed link is followed
      // logged out, so the token must be sufficient on its own.
      const r = await fetch(`${process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:33001'}/ack/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.message || `HTTP ${r.status}`);
      setFlash({ tone: 'success', text: `✓ ${data.display_name} accepted. Audit log updated.` });
      // Clear the deep-link hash so a refresh does not re-trigger the banner.
      window.history.replaceState(null, '', window.location.pathname);
      setTokenApprover(null);
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function tag(prId: string) {
    const people = draft
      .filter(d => d.email.trim())
      .map(d => ({
        taggedRole: d.taggedRole,
        name: d.name.trim() || d.email.trim(),
        email: d.email.trim(),
        deptCode: d.deptCode || undefined,
      }));
    if (!people.length) { setErr('Add at least one email address to tag.'); return; }
    setBusy(prId); setErr(null);
    try {
      await api.post(`/pr/${prId}/acknowledgements`, { approvers: people });
      setFlash({ tone: 'success', text: `Tagged ${people.length} approver(s). Each gets a unique #ack= link.` });
      setDraft(DEFAULT_TAGGED);
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Shell title="Acknowledgement requests" screenId="acknowledge" subtitle={PR_ACK_SUBTITLE}>
      {err && <div className="alert error">{err}</div>}
      {flash && <div className={`alert ${flash.tone}`}>{flash.text}</div>}

      {/* deep-link banner — prototype shows this when #ack=<token> is present */}
      {tokenApprover?.invalid && (
        <div className="alert error">
          <b>Invalid or expired link.</b> This acknowledgement link is not recognised.
          {' '}<span className="ack-deep-link">#ack={tokenApprover.token}</span>
        </div>
      )}
      {tokenApprover && !tokenApprover.invalid && (
        <div className="alert info">
          <b>Deep link detected:</b> you were invited to acknowledge{' '}
          <span className="mono">{tokenApprover.pr_number}</span> as{' '}
          <b>{tokenApprover.name || ROLE_LABEL[tokenApprover.tagged_role]}</b>.
          <div style={{ marginTop: 6 }}>
            <span className="ack-deep-link">#ack={tokenApprover.token}</span>
          </div>
          <div style={{ marginTop: 10 }}>
            {tokenApprover.acknowledged ? (
              <span>
                Already acknowledged at {fmtDateTime(tokenApprover.acknowledged_at)}.
              </span>
            ) : (
              <button className="btn success" disabled={busy === tokenApprover.token}
                onClick={() => accept(tokenApprover.token)}>
                {busy === tokenApprover.token ? 'Recording…' : 'Accept'}
              </button>
            )}
          </div>
        </div>
      )}

      {requests.length === 0 ? (
        <div className="card">
          <div className="card-b empty-state">
            No acknowledgement requests. Approvers are tagged on a PR by its requester.
          </div>
        </div>
      ) : requests.map(r => (
        <div key={r.pr_id} style={{ marginBottom: 16 }}>
          {/* Tagged approvers card */}
          <div className="card">
            <div className="card-h">
              <h3>Tagged approvers — {r.pending} pending of {r.total}</h3>
              <span className={`pill ack-${r.summary.tone}`}>{r.summary.label}</span>
            </div>
            <div className="card-b" style={{ padding: 0 }}>
              {r.approvers.map(a => (
                <div key={a.id} className="approver-row">
                  <div className="avatar">{initials(a.name)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{a.name || '(unnamed)'}</div>
                    <div className="text-sm text-mute">{a.email}</div>
                  </div>
                  <div className="role-tag">{ROLE_LABEL[a.tagged_role] || a.tagged_role}</div>
                  {a.acknowledged ? (
                    <span className="pill ack-done">✓ Acknowledged {fmtDateTime(a.acknowledged_at)}</span>
                  ) : (
                    <>
                      <span className="pill ack-pending">⏳ Awaiting ack</span>
                      <button className="btn success sm" style={{ marginLeft: 8 }}
                        disabled={busy === a.token}
                        onClick={() => accept(a.token)}>
                        Accept
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="card-b">
              {r.pending > 0 ? (
                <div className="alert warn" style={{ margin: 0 }}>
                  <b>Soft gate:</b> PR keeps moving; tagged approvers receive an email with a
                  unique <span className="ack-deep-link">#ack=&lt;token&gt;</span> link. {r.pending} still pending.
                </div>
              ) : (
                <div className="alert success" style={{ margin: 0 }}>
                  <b>All acknowledgements complete.</b> Audit log shows acceptance timestamps.
                </div>
              )}
            </div>
          </div>

          {/* PR context card */}
          <div className="card">
            <div className="card-h"><h3>PR context</h3></div>
            <div className="card-b">
              <div className="kv">
                <div className="k">PR ID</div>
                  <div className="v"><Link href={`/pr/${r.pr_id}`} className="mono">{r.pr_number}</Link></div>
                <div className="k">Title</div><div className="v">{r.title || '—'}</div>
                <div className="k">Stage</div><div className="v"><StagePill stage={r.status} /></div>
                <div className="k">Requester</div>
                  <div className="v">{r.requester_name} · <DeptChip name={r.department_name} /></div>
                <div className="k">Amount</div><div className="v"><b>{pkr(r.estimated_amount)}</b></div>
                <div className="k">Raised</div><div className="v">{fmtDateTime(r.created_at)}</div>
              </div>
            </div>
          </div>
        </div>
      ))}

      {/* Tag approvers — requester / oversight only */}
      <div className="card">
        <div className="card-h">
          <h3>Tag approvers on a PR</h3>
          <span className="meta">generates a unique #ack= link per person</span>
        </div>
        <div className="card-b">
          <p className="text-sm text-mute">
            Acknowledgement is a fraud-control record, not a workflow gate. Tagging one does not
            pause the PR.
          </p>
          <div className="ack-tagger">
            {draft.map((d, i) => (
              <div key={i} className="ack-tagger-row">
                <select value={d.taggedRole}
                  onChange={e => setDraft(ds => ds.map((x, j) => j === i ? { ...x, taggedRole: e.target.value } : x))}>
                  {Object.entries(ROLE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
                <input placeholder="Name" value={d.name}
                  onChange={e => setDraft(ds => ds.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <input placeholder="email@pakboxes.pk" value={d.email}
                  onChange={e => setDraft(ds => ds.map((x, j) => j === i ? { ...x, email: e.target.value } : x))} />
                <button className="btn sm" disabled={!draft[i].email.trim()}
                  onClick={() => setDraft(ds => [...ds, { taggedRole: 'employee', name: '', email: '' }])}>
                  + Add
                </button>
                {draft.length > 1 && (
                  <button className="btn sm"
                    onClick={() => setDraft(ds => ds.filter((_, j) => j !== i))}>−</button>
                )}
              </div>
            ))}
          </div>
          {requests.length > 0 && (
            <div className="btn-row">
              <button className="btn primary" disabled={!!busy}
                onClick={() => tag(requests[0].pr_id)}>
                Tag on {requests[0].pr_number}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Why am I being asked? — prototype's fraud-control explainer, verbatim */}
      <div className="card">
        <div className="card-h"><h3>Why am I being asked?</h3></div>
        <div className="card-b text-sm">
          Each tagged approver receives an email from <b>no-reply@pakboxes.pk</b> with a unique
          token link. When you click <b>Accept</b>, the system records your acknowledgement
          (timestamp + IP-equivalent) on the audit log, linked to this PR. The PR keeps moving
          through approval and into D365 either way — acknowledgement is a fraud-control record,
          not a workflow gate. If items arrive without your knowledge, contact IT Security.
        </div>
      </div>
    </Shell>
  );
}
