import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { LIGHT_ITEM_CATEGORIES, LIGHT_ITEM_CATEGORY_IDS } from '@procurement/workflow-engine';

/**
 * What the public form may send. Mirrors the prototype's fields exactly.
 *
 * Everything is optional at the TYPE level on purpose: the DTO validates the
 * shape of whatever IS supplied, and the service decides what is REQUIRED, so
 * that a missing field is reported with the prototype's own label ("Company
 * name") rather than the JSON key ("legalName"). Required-ness is a product
 * rule that lives with the copy, not a type.
 */
export type VendorApplicationInput = {
  legalName?: string | null;
  ntn?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  categories?: string | null;
};

/** Copy lifted from the prototype's vendor-onboard-public screen. */
export const ONBOARDING_TITLE = 'Vendor Onboarding';
export const ONBOARDING_SUBTITLE = 'Apply to become an approved vendor';
export const ONBOARDING_PUBLIC_NOTICE =
  'This is a public form — no login required. Submissions are validated by Procurement before vendor master creation.';
export const ONBOARDING_SUBMIT_SUCCESS =
  'Vendor application submitted to Procurement for review.';

// ─── Field metadata, so the form in step 5 has one source of truth ─────────
export const ONBOARDING_FIELDS = [
  { key: 'legalName', label: 'Company name', required: true },
  { key: 'ntn', label: 'NTN / Tax ID', required: true },
  { key: 'contactName', label: 'Contact person', required: false },
  { key: 'contactEmail', label: 'Email', required: false },
  { key: 'categories', label: 'Categories supplied', required: false },
] as const;

/**
 * Wave 4 step 3 — the PUBLIC vendor application intake.
 *
 * This is the only unauthenticated write surface in the API, because the
 * prototype's screen says so explicitly ("This is a public form - no login
 * required"). Everything else is behind JwtAuthGuard.
 *
 * THE REFERENCE IS NOT GENERATED HERE. `core.vendor_applications.reference` has
 * a DEFAULT from `core.fn_next_vendor_app_reference()` (migration 028), and this
 * service returns whatever the database assigned. That is the whole point of
 * W4 §7: `apps/onboarding` used to render `ONB-{Math.floor(Math.random()*
 * 99999)}`, a reference that went nowhere and collided with nothing. An
 * applicant is told a reference and has to be able to track it, so it has to be
 * real, sequential and stored.
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly db: DbService) {}

  // ── GET /onboarding/form ─────────────────────────────────────────────────
  /**
   * Everything the public form needs to render, in one call: the copy, which
   * fields are required, and the REAL category vocabulary.
   *
   * The prototype hardcodes three options — "Office equipment", "IT hardware",
   * "Services" — of which only "IT hardware" corresponds to a real value.
   *
   * ── WHICH VOCABULARY ─────────────────────────────────────────────────────
   *
   * This used to serve LIGHT_ITEM_CATEGORIES (the PR LINE categories), on the
   * reasoning that offering "the same list the rest of the app routes against"
   * prevents an application being filed under something unrecognised. The
   * premise was wrong: an application is filed under a D365 ITEM GROUP, and
   * offering line categories here meant the form could only ever produce values
   * that migration 037's post-condition would reject.
   *
   * The vocabulary is read live from `core.dimension_values`
   * (dimension_key='ItemGroup', active), which is what both migration 037 and
   * the stored vendor rows actually use. Adding an item group through
   * /admin-dimensions therefore changes this public form with no code change.
   *
   * `desc` is the display name, which is what a public applicant reads; the
   * submitted VALUE is the code, because that is what a vendor row stores.
   */
  async form() {
    const groups = await this.db.query<{ code: string; name: string }>(
      `SELECT c.code, c.name
         FROM core.categories c
        WHERE c.active
        ORDER BY c.code`,
      [],
      { bypassRls: true },
    );
    return {
      title: ONBOARDING_TITLE,
      subtitle: ONBOARDING_SUBTITLE,
      notice: ONBOARDING_PUBLIC_NOTICE,
      submitLabel: 'Submit application',
      fields: ONBOARDING_FIELDS,
      categoryOptions: (groups.rows ?? []).map((r) => ({
        id: r.code, label: r.name, desc: r.code,
      })),
    };
  }

  // ── POST /onboarding/applications ────────────────────────────────────────
  /**
   * Accept an application and return the database's reference.
   *
   * Duplicate control is `ux_vendor_app_ntn_pending` (migration 028) — one
   * LIVE application per NTN. Per W4-6 this wave builds no rate limiter, so
   * that index is the whole of the anti-spam story. It is enforced in the
   * database rather than by reading rows first, which is what makes it hold
   * under concurrent submissions instead of merely usually holding.
   */
  async submit(input: VendorApplicationInput) {
    const legalName = this.collapse(input?.legalName);
    const ntn = this.collapse(input?.ntn);
    const contactName = this.collapse(input?.contactName);
    const contactEmail = this.collapse(input?.contactEmail);
    const categories = await this.normaliseCategory(input?.categories);

    if (!legalName) throw new BadRequestException('Company name is required.');
    if (!ntn) throw new BadRequestException('NTN / Tax ID is required.');

    if (contactEmail && !this.looksLikeEmail(contactEmail)) {
      throw new BadRequestException('Email is not a valid address.');
    }

    const r = await this.db.query<any>(
      // ON CONFLICT (ntn) WHERE <predicate> DO NOTHING is how the duplicate is
      // detected, and the predicate MUST match ux_vendor_app_ntn_pending
      // exactly or PostgreSQL cannot infer the index.
      //
      // Two earlier mistakes are worth recording, because both produced a
      // confusing 500 rather than a 409:
      //
      //  1. `ON CONFLICT ON CONSTRAINT ux_vendor_app_ntn_pending` — the ON
      //     CONSTRAINT form accepts CONSTRAINTS only. ux_vendor_app_ntn_pending
      //     is a bare unique INDEX, so psql reported `constraint ... does not
      //     exist` and the submission 500'd. A real constraint would work; this
      //     one is an index.
      //  2. Letting the unique violation propagate. Through this bridge a
      //     duplicate key error surfaces as `psql exited 3: ... duplicate key`,
      //     which is an opaque 500. DO NOTHING turns it into rowCount 0.
      //
      // The race argument matters too: reading first and comparing would let
      // two simultaneous submissions both see no existing row. Letting the
      // index refuse the write is both correct and race-free.
      `INSERT INTO core.vendor_applications
         (legal_name, ntn, contact_name, contact_email, categories, state)
       VALUES ($1, $2, $3, $4, $5, 'Submitted')
       ON CONFLICT (ntn) WHERE state IN ('Submitted','Under_Review') DO NOTHING
       RETURNING id, reference, state, submitted_at`,
      [legalName, ntn, contactName || null, contactEmail || null, categories || null],
      { role: 'public', bypassRls: true },
    );

    if (r.rowCount === 0) {
      // A LIVE application already exists for this NTN. Deliberately says
      // nothing about the existing one beyond that: this is a public endpoint
      // and "application 4b21f0 exists" is information a stranger can use.
      throw new ConflictException(
        'An application for this NTN is already under review. No second one can be filed while it is live.',
      );
    }

    const row = r.rows[0];
    return {
      // The database's reference, not one this service made up.
      reference: row.reference,
      state: row.state,
      submittedAt: row.submitted_at,
      message: ONBOARDING_SUBMIT_SUCCESS,
      notice: ONBOARDING_PUBLIC_NOTICE,
      // Where the applicant can check on it. The status lookup needs their
      // email as well — see the note on status() for why that is not optional.
      statusUrl: `/onboarding/applications/${row.reference}`,
    };
  }

  // ── GET /onboarding/applications/:reference ──────────────────────────────
  /**
   * The applicant's own status lookup, by the reference they were given.
   *
   * EMAIL IS REQUIRED, and this is a real requirement, not decoration.
   * `core.seq_vendor_app_ref` is SEQUENTIAL by design (the plan asked for
   * ONB-2026-00001, 00002, ... so references read as real). That makes every
   * reference ENUMERABLE: ONB-2026-00001, 00002, ... are all guessable. If this
   * endpoint answered on the reference alone, anyone could walk the sequence
   * and read every applicant's company name, NTN and contact email. Requiring
   * the email they applied with means a guesser has to already know the thing
   * they are trying to steal.
   *
   * W4-6 removed the rate limiter, which removes the other control that would
   * have limited enumeration. This check is what remains, and it is the reason
   * the combination is safe rather than merely quiet.
   *
   * The response is deliberately a SUBSET of the row. No legal_name, no ntn, no
   * contact details come back: a status lookup that echoed the application
   * would hand over the very fields the email check is protecting.
   */
  async status(reference: string, email?: string | null) {
    const ref = this.collapse(reference);
    const who = this.collapse(email);

    if (!ref) throw new BadRequestException('reference is required');
    if (!who) {
      // Named explicitly rather than 404, because the caller CAN retry: they
      // simply have not supplied the second factor yet.
      throw new BadRequestException(
        'Provide the email address you applied with, to confirm this reference is yours.',
      );
    }

    const r = await this.db.query<any>(
      `SELECT reference, state, submitted_at, reviewed_at, decision_note, reference_note
         FROM core.vendor_applications
        WHERE reference = $1
          AND lower(contact_email) = lower($2)`,
      [ref, who],
      { role: 'public', bypassRls: true },
    );

    if (r.rows.length === 0) {
      // 404, not 403. A 403 would confirm "ONB-2026-00007 exists", which is
      // exactly the leak the email requirement exists to prevent.
      throw new NotFoundException('No application matches that reference and email.');
    }

    const a = r.rows[0];
    return {
      reference: a.reference,
      state: a.state,
      submittedAt: a.submitted_at,
      reviewedAt: a.reviewed_at,
      // decision_note is why Procurement rejected it — that note is written FOR
      // the applicant, so it is the one field here that genuinely belongs to
      // them. reference_note explains why a duplicate was allowed through.
      decisionNote: a.decision_note,
      referenceNote: a.reference_note,
      pending: ['Submitted', 'Under_Review'].includes(a.state),
      notice: ONBOARDING_PUBLIC_NOTICE,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────
  private collapse(v: unknown): string {
    return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  }

  /**
   * Normalise an applicant-supplied category into a D365 ItemGroup code.
   *
   * ── WHAT THIS USED TO DO, AND WHY IT WAS WRONG ──────────────────────────────
   *
   * It validated against `LIGHT_ITEM_CATEGORY_IDS` — the LINE categories
   * (IT_HARDWARE, OFFICE_SUPPLIES, …) — and stored the result in
   * `core.vendor_applications.categories`, which becomes
   * `core.vendors.preferred_categories`.
   *
   * But `preferred_categories` is an ItemGroup vocabulary. Migration 037 seeds it
   * from the W5-A dimension library (IG-LAPTOP, IG-ACC, IG-OFC, IG-SVC) and its
   * post-condition raises unless every stored value is an active ItemGroup code.
   * All six demo vendors hold `IG-*`.
   *
   * So the two halves disagreed, and the runtime half won in practice: a real
   * applicant picking `IG-OFC` — the value every seeded vendor uses — was refused
   * with a 400, while `OFFICE_SUPPLIES` was accepted and would then fail
   * migration 037's post-condition on the next replay. Verified against the live
   * API before this change:
   *
   *     categories="IG-OFC"          -> 400 "not a known category"
   *     categories="OFFICE_SUPPLIES"  -> 201 accepted
   *
   * ── THE VOCABULARY NOW ────────────────────────────────────────────────────
   *
   * The reference is `core.dimension_values` where `dimension_key = 'ItemGroup'`,
   * read live. That is the same table migration 037 validates against, so the two
   * can no longer disagree, and an admin adding an item group through
   * /admin-dimensions makes it available here with no code change.
   *
   * Line categories are a DIFFERENT vocabulary — they classify a PR line for
   * routing (see `core.categories` / LIGHT_ITEM_CATEGORIES) and must never be
   * written into a vendor row. Refusing them below, by name, is deliberate: a
   * silent acceptance is how the original contradiction arose.
   */
  private async normaliseCategory(v: unknown): Promise<string | null> {
    const raw = this.collapse(v);
    if (!raw) return null;

    const groups = await this.db.query<{ code: string; name: string }>(
      `SELECT c.code, c.name
         FROM core.categories c
        WHERE c.active
        ORDER BY c.code`,
      [],
      { bypassRls: true },
    );
    const rows = groups.rows ?? [];
    const codes = rows.map((r) => r.code);

    // Accept the code itself, or the display name a public form may have sent.
    const byCode = rows.find((r) => r.code.toUpperCase() === raw.toUpperCase());
    if (byCode) return byCode.code;
    const byName = rows.find((r) => r.name.toLowerCase() === raw.toLowerCase());
    if (byName) return byName.code;

    // Say precisely why an ITEM GROUP was refused. The two vocabularies are
    // still deliberately separate — a vendor is mapped to a LINE category since
    // migration 051, while D365 item groups describe a financial dimension — and
    // this is the message that stops the other half of the original confusion
    // from reappearing in the opposite direction.
    //
    // The whole ItemGroup library is read here, once, rather than asking about
    // this one value: a second round trip per rejected submission turns a typo
    // into a database query, and the set is small enough to hold.
    const igs = await this.db.query<{ code: string }>(
      `SELECT code FROM core.dimension_values WHERE dimension_key = 'ItemGroup'`,
      [],
      { bypassRls: true },
    );
    const itemGroups = new Set((igs.rows ?? []).map((r) => r.code.toUpperCase()));
    if (itemGroups.has(raw.toUpperCase())) {
      throw new BadRequestException(
        `"${raw}" is a D365 item group, not a line category. ` +
          'A vendor is mapped to a line category (the same vocabulary a PR line uses). ' +
          `Item groups belong to the D365 dimension library. Allowed categories: ${codes.join(', ')}.`,
      );
    }

    throw new BadRequestException(
      `"${raw}" is not a known line category. Allowed: ${codes.join(', ')}.`,
    );
  }

  /**
   * Deliberately permissive: a shape check, not a full RFC 5322 parser. The
   * point is to catch a typo, not to adjudicate exotic-but-legal addresses, and
   * an over-strict regex on a PUBLIC form rejects real applicants.
   */
  private looksLikeEmail(v: string): boolean {
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v);
  }
}
