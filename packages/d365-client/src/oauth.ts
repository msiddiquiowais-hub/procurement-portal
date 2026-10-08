// ═══════════════════════════════════════════════════════════════════════════
// Azure AD / Microsoft Entra ID — OAuth 2.0 client-credentials.
//
// WHY THIS EXISTS AT ALL
//
// `d365.service.ts` has read D365_TENANT_ID / CLIENT_ID / CLIENT_SECRET out of
// the environment since the first wave of this project, and nothing has ever
// used them: `pushPurchaseOrder` in stub mode invents a PO number and in live
// mode throws "not yet implemented". So the credentials were configured and
// ignored — the worst of both, because a deployment looked connected.
//
// WHAT IT DOES
//
// Standard client-credentials grant against the v2.0 endpoint:
//
//   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
//     grant_type=client_credentials
//     client_id / client_secret
//     scope = {resourceUrl}/.default
//
// `.default` rather than a bare `https://.../.default` or a Graph scope: the
// resource is the F&O environment URL, and the app registration must be granted
// consent on THAT resource. This is the single most common D365 integration
// mistake, so the scope is built explicitly and asserted below.
//
// TWO THINGS THIS REFUSES TO DO
//
// 1. Never fall back to a stub on a token failure. A silent stub fallback turns
//    an expired secret into a queue of fake purchase orders. Every failure
//    here throws, and the caller decides what to do.
//
// 2. Never log or echo the client secret. The secret is passed once, in a POST
//    body, and appears in no error message — errors from the token endpoint are
//    summarised by status code only, because the endpoint echoes request
//    parameters back in `error_description`.
// ═══════════════════════════════════════════════════════════════════════════

export type EntraConfig = {
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  /** The F&O environment root, e.g. https://contoso.operations.dynamics.com */
  resourceUrl?: string;
};

export type AccessToken = {
  accessToken: string;
  /** Absolute epoch-ms expiry. */
  expiresAt: number;
  tokenType: string;
};

/** Config problems, named. A caller can log these verbatim — none is a secret. */
export class D365ConfigError extends Error {
  constructor(public readonly missing: string[]) {
    super(
      `D365 live mode is not fully configured. Missing: ${missing.join(', ')}. ` +
      `Set these in the environment, or set D365_MODE=stub to use the ` +
      `deterministic local stub. The stub is refused automatically when live ` +
      `mode is requested with incomplete configuration — a live deployment must ` +
      `never silently fall back to inventing purchase orders.`,
    );
    this.name = 'D365ConfigError';
  }
}

export class D365AuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    /** A short, secret-free hint. The raw body is deliberately not carried. */
    hint: string,
  ) {
    // NOTE: the token endpoint's `error_description` frequently repeats request
    // parameters, so only the `error` code and the HTTP status are surfaced.
    super(`D365 authentication failed (HTTP ${status}, ${code}): ${hint}`);
    this.name = 'D365AuthError';
  }
}

/** The v2.0 token endpoint for a tenant. `common` is a real, valid tenant alias. */
export function tokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

/**
 * The resource scope.
 *
 * The `.default` suffix is mandatory for F&O: it asks for every permission the
 * app registration has been consented to ON THIS RESOURCE. Sending a Graph
 * scope, or the resource without `.default`, authenticates against the wrong
 * audience and yields a token F&O rejects with 401 on the first OData call —
 * a confusing failure far from its cause.
 */
export function resourceScope(resourceUrl: string): string {
  const trimmed = resourceUrl.replace(/\/+$/, '');
  return `${trimmed}/.default`;
}

/**
 * Validate configuration without performing a network call.
 *
 * Separated from the token fetch so the API can answer "is D365 configured?"
 * on a health screen, and so a harness can prove the fail-closed behaviour
 * without a tenant.
 */
export function missingConfig(cfg: EntraConfig): string[] {
  const missing: string[] = [];
  if (!cfg.tenantId) missing.push('D365_TENANT_ID');
  if (!cfg.clientId) missing.push('D365_CLIENT_ID');
  if (!cfg.clientSecret) missing.push('D365_CLIENT_SECRET');
  if (!cfg.resourceUrl) missing.push('D365_BASE_URL');
  return missing;
}

export function assertConfigured(cfg: EntraConfig): void {
  const missing = missingConfig(cfg);
  if (missing.length > 0) throw new D365ConfigError(missing);
}

/**
 * Refresh this many ms before the token actually expires.
 *
 * A token fetched with 5 seconds of life is worse than useless: it will expire
 * between the auth call and the OData POST, and the failure looks like a D365
 * permission problem rather than a clock problem.
 */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

type FetchLike = typeof fetch;

export class EntraTokenProvider {
  private cached: AccessToken | null = null;
  private inflight: Promise<AccessToken> | null = null;

  constructor(
    private readonly cfg: EntraConfig,
    private readonly deps: { fetch?: FetchLike; now?: () => number } = {},
  ) {}

  private get doFetch(): FetchLike {
    return this.deps.fetch ?? fetch;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** True when a cached token exists and is still comfortably valid. */
  get hasFreshToken(): boolean {
    return !!this.cached && this.cached.expiresAt - EXPIRY_SKEW_MS > this.now();
  }

  /** Seconds remaining, for a status screen. Never the token itself. */
  get expiresInSeconds(): number | null {
    if (!this.cached) return null;
    return Math.max(0, Math.round((this.cached.expiresAt - this.now()) / 1000));
  }

  async getToken(): Promise<AccessToken> {
    if (this.hasFreshToken) return this.cached!;

    // Collapse a thundering herd: ten concurrent sync jobs must mint ONE token,
    // not ten. Without this, each caller separately hits Entra and the app
    // walks into the tenant's throttling limit within a minute of starting.
    if (!this.inflight) {
      this.inflight = this.fetchToken().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  private async fetchToken(): Promise<AccessToken> {
    assertConfigured(this.cfg);
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.cfg.clientId!,
      client_secret: this.cfg.clientSecret!,
      scope: resourceScope(this.cfg.resourceUrl!),
    });

    const res = await this.doFetch(tokenEndpoint(this.cfg.tenantId!), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* non-JSON error page */ }

    if (!res.ok || !json.access_token) {
      const code = typeof json.error === 'string' ? json.error : 'no_access_token';
      // The common ones, said plainly. `invalid_client` in particular is almost
      // always a secret that was rotated without updating the deployment.
      const hints: Record<string, string> = {
        invalid_client:
          'the client id or secret is wrong, or the secret was rotated without ' +
          'updating this deployment',
        unauthorized_client:
          'the app registration is not authorised for the client-credentials ' +
          'grant — enable it under Certificates & secrets / App roles',
        invalid_scope:
          `the app registration has no consented permission on ${this.cfg.resourceUrl}. ` +
          'Grant an F&O delegated or application permission on THIS resource.',
        tenant_not_found: 'D365_TENANT_ID is not a real tenant (or is not a GUID)',
      };
      throw new D365AuthError(res.status, code, hints[code] ?? 'see the Entra response for detail');
    }

    const lifetimeSeconds = Number(json.expires_in);
    if (!Number.isFinite(lifetimeSeconds) || lifetimeSeconds <= 0) {
      throw new D365AuthError(res.status, 'no_expires_in', 'the token response carried no usable expires_in');
    }

    this.cached = {
      accessToken: String(json.access_token),
      tokenType: String(json.token_type || 'Bearer'),
      expiresAt: this.now() + lifetimeSeconds * 1000,
    };
    return this.cached;
  }

  /** Drop the cached token — on a 401 from OData, before one forced refresh. */
  invalidate(): void {
    this.cached = null;
  }
}
