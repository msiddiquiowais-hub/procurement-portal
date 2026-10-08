// Roles, screen registry and sidebar navigation — port of the prototype's
// ROLE_ALIASES / roleAllowed() / TITLES / sidebar markup.
//
// B4 of PROCUREMENT_PORTAL_PORT_GAP_MATRIX.md. The prototype gates every
// screen by a `data-roles` CSV on the nav item and resolves super-roles
// through ROLE_ALIASES. The application had a 2-item nav with no alias
// resolution, so an `admin` session saw almost nothing. This module is the
// single source of truth both the API (guards) and the web Shell (rendering)
// read, so the two can never disagree about who may see what.

export type Role =
  | 'admin'
  | 'requester'
  | 'hod'
  | 'procurement'
  | 'cs'
  | 'mc'
  | 'cfo'
  | 'vendor'
  | 'finance'
  | 'management'
  | 'warehouse_manager'
  | 'store_incharge'
  | 'it_manager'
  | 'cost_center_owner'
  | 'audit'
  | 'system';

export const ALL_ROLES: Role[] = [
  'admin', 'requester', 'hod', 'procurement', 'cs', 'mc', 'cfo', 'vendor',
  'finance', 'management', 'warehouse_manager', 'store_incharge',
  'it_manager', 'cost_center_owner', 'audit', 'system',
];

/**
 * Super-role expansion. `admin` is treated as a super-role that sees every
 * screen a CS, Procurement officer, HOD, Finance officer, Management member,
 * MC member or Warehouse Manager can see.
 *
 * Faithful to the prototype's ROLE_ALIASES. Add new aliases here rather than
 * special-casing `admin` at a call site.
 */
export const ROLE_ALIASES: Record<string, Role[]> = {
  admin: ['cs', 'procurement', 'cfo', 'hod', 'finance', 'management', 'mc', 'warehouse_manager'],
};

/** The roles the prototype's header "Acting as" pill offers, in order. */
export const ROLE_SELECT_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: 'admin', label: 'Admin (Owais)' },
  { value: 'requester', label: 'Requester (Owais)' },
  { value: 'hod', label: 'HOD' },
  { value: 'procurement', label: 'Procurement Officer' },
  { value: 'cs', label: 'Committee Secretary' },
  { value: 'mc', label: 'MC Member' },
  { value: 'cfo', label: 'CFO' },
  { value: 'vendor', label: 'Vendor (PakBoxes)' },
  { value: 'finance', label: 'Finance Officer' },
  { value: 'management', label: 'Management (Ahmed Raza)' },
  { value: 'warehouse_manager', label: 'Warehouse Manager' },
];

export const ROLE_LABELS: Record<string, string> = {
  requester: 'Requester',
  hod: 'HOD',
  procurement: 'Procurement',
  cs: 'CS',
  cost_center_owner: 'Cost Center',
  finance: 'Finance',
  management: 'Management',
  mc: 'MC',
  cfo: 'CFO',
  audit: 'Audit',
  admin: 'Admin',
  vendor: 'Vendor',
  store_incharge: 'Store In-charge',
  warehouse_manager: 'Warehouse Manager',
  it_manager: 'IT Manager',
  system: 'System',
};

/**
 * Is `currentRole` permitted on a screen whose `data-roles` CSV is
 * `allowedCsv`? Port of the prototype's roleAllowed().
 *
 * `'all'` means unrestricted. Otherwise the role matches directly or through
 * its alias expansion.
 */
export function roleAllowed(currentRole: string, allowedCsv: string): boolean {
  if (allowedCsv === 'all') return true;
  const allowed = allowedCsv.split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.includes(currentRole as Role)) return true;
  const aliases = ROLE_ALIASES[currentRole] || [];
  return aliases.some(a => allowed.includes(a));
}

/** Every role (including the viewer's own aliases) that can see a screen. */
export function rolesFor(allowedCsv: string): string[] {
  if (allowedCsv === 'all') return [...ALL_ROLES];
  const allowed = allowedCsv.split(',').map(s => s.trim()).filter(Boolean);
  const out = new Set<string>(allowed);
  for (const [superRole, members] of Object.entries(ROLE_ALIASES)) {
    if (members.some(m => allowed.includes(m))) out.add(superRole);
  }
  return [...out];
}

export type ScreenId =
  | 'dashboard' | 'kpi'
  | 'pr-detail' | 'pr-review' | 'rfq-detail' | 'cs' | 'mc-vote' | 'cfo-approve'
  | 'pack' | 'd365-push' | 'd365-status'
  | 'my-prs' | 'pr-create' | 'light-pr-new' | 'light-pr-list' | 'light-pr-detail'
  | 'approvals' | 'rfq-list' | 'supplier-rfq' | 'supplier-quote'
  | 'vendors' | 'vendor-detail' | 'vendor-risk'
  | 'audit' | 'audit-report'
  | 'admin-matrix' | 'admin-workflow' | 'admin-dimensions' | 'admin-uom'
  | 'admin-categories'
  | 'settings' | 'acknowledge'
  | 'vendor-onboard-public' | 'login';

export type ScreenDef = {
  id: ScreenId;
  label: string;
  /** The prototype's `data-roles` CSV, verbatim. */
  roles: string;
  /** Prototype icon id (the `#i-*` sprite reference). */
  icon: string;
  /** Nav group; omitted for screens reached by navigation rather than the sidebar. */
  section?: NavSection;
  /** Full-screen layouts render outside the app shell. */
  fullScreen?: boolean;
  /** Not shown in the sidebar (detail routes reached from a list). */
  hiddenInNav?: boolean;
};

export type NavSection = 'Overview' | 'Walkthrough' | 'Library' | 'Public surfaces';

/**
 * The prototype's sidebar, in order, with the prototype's exact `data-roles`
 * values. 33 of these are the prototype's own screens (31 in the sidebar +
 * light-pr-detail, which is reached from the list, + the two full-screen public
 * surfaces).
 *
 * The registry holds 34 because `admin-categories` is a Wave 5 addition, like
 * admin-matrix, admin-dimensions and admin-uom beside it. Those four are real
 * API-backed screens over real tables, not control panels — the failure mode
 * Part 8 exists to prevent — so the extra entry is a feature of the port rather
 * than a deviation from it. Keep this count and the one in roles.test.ts in
 * step when a screen is added deliberately.
 */
export const SCREENS: ScreenDef[] = [
  // ── Overview ────────────────────────────────────────────────────────────
  { id: 'dashboard', label: 'Dashboard', roles: 'all', icon: 'i-chart', section: 'Overview' },
  { id: 'kpi', label: 'KPI Dashboard', roles: 'all', icon: 'i-chart', section: 'Overview' },

  // ── Walkthrough ─────────────────────────────────────────────────────────
  { id: 'pr-detail', label: 'PR-2026-00234', roles: 'all', icon: 'i-doc', section: 'Walkthrough' },
  { id: 'pr-review', label: 'PR Review', roles: 'hod', icon: 'i-edit', section: 'Walkthrough' },
  { id: 'rfq-detail', label: 'RFQ & Quotes', roles: 'procurement,cs,hod,vendor,mc,cfo', icon: 'i-inbox', section: 'Walkthrough' },
  { id: 'cs', label: 'Comparative Stmt', roles: 'procurement,cs,hod,mc,cfo', icon: 'i-build', section: 'Walkthrough' },
  { id: 'mc-vote', label: 'MC Vote', roles: 'mc', icon: 'i-users', section: 'Walkthrough' },
  { id: 'cfo-approve', label: 'CFO Approval', roles: 'cfo', icon: 'i-shield', section: 'Walkthrough' },
  { id: 'pack', label: 'Approved Pack', roles: 'cs,procurement,cfo', icon: 'i-package', section: 'Walkthrough' },
  { id: 'd365-push', label: 'Push to D365', roles: 'cs,procurement', icon: 'i-upload', section: 'Walkthrough' },
  { id: 'd365-status', label: 'D365 Status', roles: 'all', icon: 'i-refresh', section: 'Walkthrough' },

  // ── Library ─────────────────────────────────────────────────────────────
  { id: 'my-prs', label: 'My PRs', roles: 'requester,hod,procurement,cs,mc,cfo', icon: 'i-doc', section: 'Library' },
  { id: 'pr-create', label: 'New PR', roles: 'requester', icon: 'i-plus', section: 'Library' },
  { id: 'light-pr-new', label: 'New Purchase Request', roles: 'requester,hod,procurement,finance,cfo,management', icon: 'i-plus', section: 'Library' },
  { id: 'light-pr-list', label: 'My Light PRs', roles: 'requester,hod,procurement,finance,cfo,management', icon: 'i-doc', section: 'Library' },
  { id: 'light-pr-detail', label: 'Purchase Request', roles: 'all', icon: 'i-doc', hiddenInNav: true },
  { id: 'approvals', label: 'My Approvals', roles: 'hod,mc,cfo,cs', icon: 'i-bell', section: 'Library' },
  { id: 'rfq-list', label: 'RFQs', roles: 'procurement,cs', icon: 'i-inbox', section: 'Library' },
  { id: 'supplier-rfq', label: 'Supplier Inbox', roles: 'vendor', icon: 'i-mail', section: 'Library' },
  { id: 'supplier-quote', label: 'Submit Quote', roles: 'vendor', icon: 'i-upload', section: 'Library' },
  { id: 'vendors', label: 'Vendor Master', roles: 'procurement,hod,cs', icon: 'i-truck', section: 'Library' },
  { id: 'vendor-detail', label: 'Vendor Detail', roles: 'procurement,hod,cs', icon: 'i-user', section: 'Library' },
  { id: 'vendor-risk', label: 'Vendor Risk', roles: 'procurement,hod,cs', icon: 'i-shield', section: 'Library' },
  { id: 'audit', label: 'Audit Log', roles: 'procurement,cs,cfo,hod', icon: 'i-lock', section: 'Library' },
  { id: 'audit-report', label: 'Printable Audit Report', roles: 'all', icon: 'i-doc', section: 'Library' },
  { id: 'admin-matrix', label: 'Authority Matrix', roles: 'cs,procurement,cfo', icon: 'i-settings', section: 'Library' },
  { id: 'admin-workflow', label: 'Workflow Config', roles: 'cs,procurement', icon: 'i-build', section: 'Library' },
  { id: 'admin-dimensions', label: 'D365 Dimensions', roles: 'cs,procurement,cfo', icon: 'i-settings', section: 'Library' },
  { id: 'admin-uom', label: 'D365 UOM', roles: 'cs,procurement,cfo', icon: 'i-settings', section: 'Library' },
  { id: 'admin-categories', label: 'Line Categories', roles: 'cs,procurement,cfo', icon: 'i-settings', section: 'Library' },
  { id: 'settings', label: 'Settings', roles: 'all', icon: 'i-settings', section: 'Library' },
  { id: 'acknowledge', label: 'Acknowledge request', roles: 'all', icon: 'i-mail', section: 'Library' },

  // ── Public surfaces (full-screen, outside the app shell) ─────────────────
  { id: 'login', label: 'Login page', roles: 'all', icon: 'i-user', section: 'Public surfaces', fullScreen: true },
  { id: 'vendor-onboard-public', label: 'Vendor onboarding', roles: 'all', icon: 'i-truck', section: 'Public surfaces', fullScreen: true },
];

export const NAV_SECTIONS: NavSection[] = ['Overview', 'Walkthrough', 'Library', 'Public surfaces'];

export function screenById(id: string): ScreenDef | undefined {
  return SCREENS.find(s => s.id === id);
}

/**
 * Can `role` open the screen with this ScreenId?
 *
 * Use THIS, not roleAllowed(), when you hold a screen id. roleAllowed() takes
 * a role CSV (`'hod,mc,cfo,cs'`), so passing a ScreenId like `'approvals'`
 * splits to `['approvals']`, matches no role, and silently returns false —
 * which locked /pr/create, /approvals and /pr/review/[id] for every user.
 * An unknown screen id is denied rather than granted.
 */
export function canSeeScreen(role: string, screenId: string): boolean {
  const s = screenById(screenId);
  return s ? roleAllowed(role, s.roles) : false;
}

/** The sidebar as the Shell should render it, already filtered for the role. */
export function navFor(role: string): Array<{ section: NavSection; items: ScreenDef[] }> {
  return NAV_SECTIONS
    .map(section => ({
      section,
      items: SCREENS.filter(s => s.section === section && roleAllowed(role, s.roles)),
    }))
    .filter(g => g.items.length > 0);
}

/** Every screen the given role may open — the API guard's allowlist. */
export function allowedScreenIds(role: string): ScreenId[] {
  return SCREENS.filter(s => roleAllowed(role, s.roles)).map(s => s.id);
}
