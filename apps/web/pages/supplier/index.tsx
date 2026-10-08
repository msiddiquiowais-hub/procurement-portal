// `supplier-rfq` — the Supplier RFQ Inbox.
//
// Port of renderSupplierInbox (prototype line 9001-9035). Gated to role
// 'vendor' by the sidebar's data-roles, and by SupplierGuard server-side — the
// nav entry is a convenience, the guard is the boundary.
//
// The page holds NO business logic. It fetches the inbox (already computed by
// the API through the engine's inboxKpis/supplierRoster) and hands it to the
// components. Every number a supplier sees was computed on the server, so this
// screen cannot disagree with the API about a total or a status.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import {
  SupplierKpiBand, SupplierInboxList, type InboxData,
} from '../../components/supplier/SupplierCards';

export default function SupplierInbox() {
  const { session, ready } = useSession();
  const router = useRouter();
  const [data, setData] = useState<InboxData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/'); return; }
    api.get<InboxData>('/supplier/inbox')
      .then(r => setData(r.data))
      .catch(e => setErr(e.message));
  }, [ready, session]);

  if (!ready) return null;
  if (!session) return null;

  // A back-office session can reach this URL by typing it. The API refuses with
  // 403 and the message says why; rendering the refusal is better than a blank
  // screen, and better than a redirect that hides the reason.
  return (
    <Shell title="Supplier RFQ Inbox" screenId="supplier-rfq" subtitle={data?.subtitle}>
      {err && <div className="alert error">{err}</div>}
      {!err && !data && <div className="card"><div className="card-b empty-state">Loading&hellip;</div></div>}

      {data && !data.empty && <SupplierKpiBand kpis={data.kpis} />}
      {data && (
        <SupplierInboxList
          data={data}
          onQuote={(id) => router.push(`/supplier/${id}`)}
        />
      )}
    </Shell>
  );
}
