import Link from 'next/link';
import { useRouter } from 'next/router';
import { ReactNode, useEffect, useState } from 'react';
import { useSession } from '../lib/session';
import {
  ROLE_LABELS,
  navFor,
  canSeeScreen,
  type ScreenDef,
} from '@procurement/roles';

/**
 * Screen id -> Next.js route. Mirrors the prototype's screen ids one-to-one so
 * a ported page keeps the prototype's identity in code, not just in look.
 *
 * A screen with no route here has not been ported yet (see
 * PROCUREMENT_PORTAL_PORT_GAP_MATRIX.md for the wave it lands in). Those items
 * still render in the sidebar so the role-gated structure is visible and
 * testable, but they are inert rather than 404-ing.
 */
const ROUTES: Record<string, string> = {
  dashboard: '/dashboard',
  approvals: '/approvals',
  acknowledge: '/acknowledge',
  'my-prs': '/my-prs',
  'pr-create': '/pr/create',
  // The prototype's "My Light PRs" is the light-flow list screen.
  'light-pr-list': '/pr',
  'light-pr-new': '/pr/new',
  'light-pr-detail': '/pr',
  // PR Review needs a PR id, so the nav entry lands on the review queue.
  'pr-review': '/approvals',
  // Wave 2 sourcing. `rfq-list` is a real route; `rfq-detail` needs an RFQ id,
  // so its nav entry lands on the list where a row can be opened — the same
  // pattern `pr-review` uses for the review queue.
  'rfq-list': '/rfq',
  'rfq-detail': '/rfq',
  // Wave 3 governance. All five prototype screens act on ONE PR
  // (STATE.pr), and the app has many — so the nav entry lands on the approvals
  // queue, which is where a role sees what is waiting for it. This is the same
  // compromise `pr-review` and `rfq-detail` already make. The per-PR screens
  // themselves are `/mc/[id]`, `/cfo/[id]`, `/pack/[id]`, `/d365/push/[id]` and
  // `/d365/status/[id]`, and each page links to the next in the chain once the
  // PR is known.
  'mc-vote': '/approvals',
  'cfo-approve': '/approvals',
  'pack': '/approvals',
  'd365-push': '/approvals',
  'd365-status': '/approvals',
  // Wave 4 supplier. Both prototype screens are vendor-only and live in this
  // app, because apps/supplier was retired (W4-1). `supplier-quote` needs an
  // invitation id, so its nav entry lands on the inbox where a row opens the
  // form — the same pattern `pr-review` and `rfq-detail` already use.
  'supplier-rfq': '/supplier',
  'supplier-quote': '/supplier',
  // Part 7 Dynamic Workflow Visual Builder. Real route: the backend binding
  // (apps/api/src/workflow) landed first so the grid edits persisted data the
  // routing engine actually reads, rather than a control panel over a constant.
  'admin-workflow': '/admin-workflow',
  // Wave 5 Track C. The four admin screens. Each is backed by a real API over the
  // tables Track A created and Track B exposed, so an edit here changes data the
  // routing engine, the D365 push and the PR screens actually read:
  //   admin-matrix      Capex/Opex band tables -> PUT /admin/authority-matrix
  //   admin-dimensions  the 9 value libraries  -> /admin/dimensions
  //   admin-uom         the UOM catalog        -> /admin/uom
  //   admin-categories  line categories        -> /admin/categories, the same
  //                      vocabulary the /pr/new dropdown reads and
  //                      proc.pr_lines.category is foreign-keyed to
  //   settings          the 11 toggles + scalars -> PATCH /admin/settings, whose
  //                      management threshold lands in workflow.config
  'admin-matrix': '/admin-matrix',
  'admin-dimensions': '/admin-dimensions',
  'admin-uom': '/admin-uom',
  'admin-categories': '/admin-categories',
  settings: '/settings',
  // Wave 5 Track D. The vendor trio. Each is backed by the real risk model in
  // core.fn_vendor_composite(), so the Risk column, the risk matrix and the RFQ
  // invitation guard are the same fact rather than three copies of it.
  //   vendors        Vendor Master   -> GET /vendors
  //   vendor-risk    Vendor Risk     -> GET /vendors/risk
  // `vendor-detail` needs a vendor id, so its nav entry lands on the list where a
  // row opens the detail — the same pattern `pr-review` and `rfq-detail` use. The
  // per-vendor screen itself is /vendor/[id].
  vendors: '/vendors',
  'vendor-detail': '/vendors',
  'vendor-risk': '/vendor-risk',
  login: '/',
  'vendor-onboard-public': '/onboarding',
};

/**
 * Waves from the gap matrix, shown on not-yet-ported nav items.
 *
 * `admin-matrix`, `admin-dimensions`, `admin-uom` and `settings` were removed here
 * in Wave 5 Track C, and `vendors` / `vendor-detail` / `vendor-risk` in Track D: a
 * screen that renders must not still be badged "Wave 5", or the badge becomes a
 * claim the UI contradicts.
 */
const PENDING: Record<string, string> = {
  'kpi': 'Wave 6',
  audit: 'Wave 6', 'audit-report': 'Wave 6',
};

function NavRow({ item, role }: { item: ScreenDef; role: string }) {
  const href = ROUTES[item.id];
  const isPending = !href;
  const cls = `nav-item${isPending ? ' nav-item-pending' : ''}`;

  if (isPending) {
    return (
      <div className={cls} title={`${item.label} — not yet ported (${PENDING[item.id] || 'planned'})`} aria-disabled="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
        </svg>
        {item.label}
        <span className="nav-badge">{PENDING[item.id] || '—'}</span>
      </div>
    );
  }

  return (
    <Link href={href} className={cls} data-screen={item.id} data-roles={item.roles}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={ICON[item.icon] || ICON['i-doc']} />
      </svg>
      {item.label}
    </Link>
  );
}

// The prototype's #i-* sprite paths, lifted into inline SVG for the React shell.
const ICON: Record<string, string> = {
  'i-chart': 'M3 3v18h18M7 14l4-4 4 4 5-5',
  'i-doc': 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6',
  'i-edit': 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4z',
  'i-inbox': 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5.5h13L22 12v7a2 2 0 01-2 2H4a2 2 0 01-2-2v-7z',
  'i-build': 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6',
  'i-users': 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  'i-shield': 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  'i-package': 'M21 16V8l-9-5-9 5v8l9 5 9-5zM3.3 7.5L12 12.5l8.7-5M12 22V12.5',
  'i-upload': 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12',
  'i-refresh': 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15',
  'i-plus': 'M12 5v14M5 12h14',
  'i-bell': 'M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0',
  'i-mail': 'M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zM22 6l-10 7L2 6',
  'i-truck': 'M1 3h15v13H1zM16 8h4l3 3v5h-7V8zM5.5 21a2.5 2.5 0 100-5 2.5 2.5 0 000 5M18.5 21a2.5 2.5 0 100-5 2.5 2.5 0 000 5',
  'i-user': 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8',
  'i-lock': 'M5 11h14a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a2 2 0 012-2zM7 11V7a5 5 0 0110 0v4',
  'i-settings': 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.6 1.6 0 008 19.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H2a2 2 0 110-4h.1A1.6 1.6 0 003.6 8a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H8a1.6 1.6 0 001-1.5V2a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V8a1.6 1.6 0 001.5 1H22a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z',
};

export default function Shell({ children, title, subtitle, screenId, preTitle, actions }: {
  children: ReactNode;
  title: string;
  subtitle?: string;
  /** Prototype screen id this page is a port of. */
  screenId?: string;
  /**
   * Rendered ABOVE the page title.
   *
   * The prototype's Part 7 builder puts its "Visual Workflow Diagram" card
   * first and the title second, so the diagram is visible before the reader
   * knows what page they are on. Shell owns the title, so a `preTitle` slot is
   * the only way to honour that ordering without forking the shell.
   */
  preTitle?: ReactNode;
  /** Right-aligned header actions, e.g. the builder's Save / Reset buttons. */
  actions?: ReactNode;
}) {
  const { session, logout } = useSession();
  const router = useRouter();
  const [walkthroughHidden, setWalkthroughHidden] = useState(false);

  useEffect(() => {
    setWalkthroughHidden(sessionStorage.getItem('pk_walkthrough_dismissed') === '1');
  }, []);

  if (!session) return null;

  const role = session.user.role;
  const groups = navFor(role);
  const dismissWalkthrough = () => {
    sessionStorage.setItem('pk_walkthrough_dismissed', '1');
    setWalkthroughHidden(true);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">P</div>
          <div>
            <div className="brand-name">Procurement</div>
            <div className="brand-sub">Portal &middot; PakBoxes</div>
          </div>
        </div>

        <div className="sidebar-scroll">
          {groups.map((g) => (
            <div key={g.section}>
              <div className="nav-section">{g.section}</div>
              {g.items.map((it) => <NavRow key={it.id} item={it} role={role} />)}
            </div>
          ))}
        </div>

        <div className="nav-section">Session</div>
        <div className="nav-item" onClick={logout} style={{ cursor: 'pointer' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
          </svg>
          Sign out
        </div>
      </aside>

      <div className="main">
        <header className="header">
          <nav className="breadcrumb" aria-label="breadcrumb">
            <Link href="/dashboard" style={{ color: 'inherit' }}>Home</Link>
            <span className="crumb-sep">/</span>
            <span className="crumb-cur">{title}</span>
          </nav>
          <div className="header-right">
            <div className="role-pill">
              <span className="role-dot" />
              <select value={role} disabled aria-label="Role">
                <option value={role}>{ROLE_LABELS[role] || role}</option>
              </select>
            </div>
            <span className="text-sm text-mute">{session.user.displayName}</span>
            <button className="btn sm" onClick={logout}>Sign out</button>
          </div>
        </header>

        <div className="content">
          {!walkthroughHidden && router.pathname === '/dashboard' && (
            <div className="walkthrough" role="status">
              <div className="step-num">1</div>
              <div className="step-text">
                You&apos;re signed in as <b>{ROLE_LABELS[role] || role}</b>. Your sidebar shows
                every screen you can open &mdash; greyed items are the prototype screens not yet
                ported. Start with <code>New Purchase Request</code>.
              </div>
              <button className="skip" onClick={dismissWalkthrough}>Dismiss</button>
            </div>
          )}
          {preTitle}
          <h1 className="page-title">{title}</h1>
          {subtitle && <p className="page-sub">{subtitle}</p>}
          {actions && <div className="btn-row" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>{actions}</div>}
          {children}
        </div>
      </div>
    </div>
  );
}

/** Guard helper for pages that declare a prototype screen id. */
export function canSee(role: string, screenId: string): boolean {
  // Must resolve the screen's own role CSV — roleAllowed() takes a CSV, not an id.
  return canSeeScreen(role, screenId);
}
