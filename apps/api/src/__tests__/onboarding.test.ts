// Onboarding intake test suite — the pure, testable half of step 3.
//
// The submission and lookup paths are covered by the live probe (they need a
// database and the unique index to mean anything). What is tested HERE is the
// part that can be wrong without a database: the copy, the form metadata, and
// the category normaliser that decides what may be stored.
//
// Run with: node --test dist/__tests__/onboarding.test.js (after build)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OnboardingService,
  ONBOARDING_TITLE,
  ONBOARDING_SUBTITLE,
  ONBOARDING_PUBLIC_NOTICE,
  ONBOARDING_SUBMIT_SUCCESS,
  ONBOARDING_FIELDS,
} from '../onboarding/onboarding.service';
import { DbService } from '../db/db.service';
import { LIGHT_ITEM_CATEGORY_IDS } from '@procurement/workflow-engine';

/** A DbService stand-in: records the query, returns whatever the test says. */
function dbReturning(rows: any[], rowCount = rows.length) {
  return {
    query: async () => ({ rows, rowCount }),
  } as unknown as DbService;
}

/**
 * A DbService stand-in that answers BOTH vocabularies correctly.
 *
 * The simple `dbReturning` returns one row set for every query, which is fine
 * until a test needs to distinguish them — and since migration 051 the
 * normaliser reads core.categories AND core.dimension_values in the same call,
 * so a test about "this is an item group, not a category" cannot be expressed
 * with a single-row-set mock. Returning the right rows per query is what lets
 * the rejection message be asserted honestly.
 */
function dbWithVocabularies(categories: any[], itemGroups: any[]) {
  return {
    query: async (sql: string) => {
      if (/FROM core\.categories/.test(sql)) {
        return { rows: categories, rowCount: categories.length };
      }
      if (/dimension_values/.test(sql)) {
        return { rows: itemGroups, rowCount: itemGroups.length };
      }
      return {
        rows: [{ id: 'i', reference: 'ONB-2026-00001', state: 'Submitted', submitted_at: 'n' }],
        rowCount: 1,
      };
    },
  } as unknown as DbService;
}

const svc = (rows: any[] = [], rowCount?: number) =>
  new OnboardingService(dbReturning(rows, rowCount));

/**
 * What core.categories returns.
 *
 * Since migration 051 a vendor is mapped to a LINE category — the same
 * vocabulary the PR form and the admin categories screen use — not to a D365
 * item group. Fixtured rather than read live so the assertion is about the
 * service's behaviour, not about whatever the database currently contains.
 */
const CATEGORY_ROWS = [
  { code: 'IT_HARDWARE', name: 'IT hardware' },
  { code: 'OFFICE_SUPPLIES', name: 'Office supplies' },
  { code: 'PROFESSIONAL_SERVICES', name: 'Professional services' },
  { code: 'FACILITIES', name: 'Facilities / FM' },
];

/** The OTHER vocabulary, which must still be refused by name. */
const ITEM_GROUP_ROWS = [
  { code: 'IG-LAPTOP', name: 'Laptops & PCs' },
  { code: 'IG-OFC', name: 'Office Supplies' },
];

// ─── Copy ───────────────────────────────────────────────────────────────────

test('O1 the screen copy is the prototype\'s, verbatim', () => {
  assert.equal(ONBOARDING_TITLE, 'Vendor Onboarding');
  assert.equal(ONBOARDING_SUBTITLE, 'Apply to become an approved vendor');
  assert.equal(ONBOARDING_SUBMIT_SUCCESS, 'Vendor application submitted to Procurement for review.');
});

test('O2 the public-form notice keeps both of its claims', () => {
  // "no login required" is the load-bearing half: it is why this controller is
  // the only unguarded one. "validated by Procurement before vendor master
  // creation" is the promise that makes an application worth submitting at all.
  assert.match(ONBOARDING_PUBLIC_NOTICE, /public form/);
  assert.match(ONBOARDING_PUBLIC_NOTICE, /no login required/);
  assert.match(ONBOARDING_PUBLIC_NOTICE, /validated by Procurement before vendor master creation/);
});

test('O3 exactly Company name and NTN are required, as the prototype marks them', () => {
  const required = ONBOARDING_FIELDS.filter((f) => f.required).map((f) => f.key);
  assert.deepEqual(required, ['legalName', 'ntn']);
});

test('O4 the NTN field keeps the prototype\'s own label', () => {
  // "NTN / Tax ID", not "ntn" and not "NTN (tax ID)".
  assert.equal(ONBOARDING_FIELDS.find((f) => f.key === 'ntn')?.label, 'NTN / Tax ID');
  assert.equal(ONBOARDING_FIELDS.find((f) => f.key === 'legalName')?.label, 'Company name');
});

test('O5 the form exposes the REAL category vocabulary, not the prototype 3', async () => {
  // The vocabulary is the LINE CATEGORIES in core.categories — the same set the
  // admin categories screen edits and the same set a vendor is mapped to since
  // migration 051. Offering a different vocabulary here would let an applicant
  // apply with a value the vendor master could not store.
  const form = await svc(CATEGORY_ROWS).form();
  assert.equal(form.categoryOptions.length, CATEGORY_ROWS.length);
  // The prototype offered "Office equipment", which is not a value anything in
  // this system recognises.
  assert.ok(!form.categoryOptions.some((o: any) => o.id === 'Office equipment'));
  assert.ok(form.categoryOptions.some((o: any) => o.id === 'OFFICE_SUPPLIES'));
  assert.ok(form.categoryOptions.every((o: any) => o.id && o.label && o.desc));
  // The trap that caused the original bug is now INVERTED. It used to be "a line
  // category must never appear in the vendor vocabulary", because the vendor
  // vocabulary was the D365 ItemGroup library. Migration 051 made the LINE
  // categories the vendor vocabulary — the original mismatch was that the public
  // form and the vendor master disagreed — so the guard is now that no D365 ITEM
  // GROUP leaks in, which is the mistake an operator would make next.
  assert.ok(
    !form.categoryOptions.some((o: any) => /^IG-/.test(String(o.id))),
    'a D365 item group leaked into the vendor line-category vocabulary',
  );
  assert.ok(
    form.categoryOptions.every((o: any) => LIGHT_ITEM_CATEGORY_IDS.includes(o.id)),
    'the public form and the vendor master must offer the SAME vocabulary — '
    + 'that mismatch is the bug this whole wave exists to close',
  );
});

// ─── Submission ─────────────────────────────────────────────────────────────

test('O6 a missing company name is refused with the prototype\'s wording', async () => {
  // NOT "legalName should be a string" — the applicant sees a form labelled
  // "Company name", so that is the word the error must use.
  await assert.rejects(
    () => svc().submit({ ntn: '1234567-8' }),
    /Company name is required/,
  );
});

test('O7 a missing NTN is refused with the prototype\'s wording', async () => {
  await assert.rejects(
    () => svc().submit({ legalName: 'Acme Supplies' }),
    /NTN \/ Tax ID is required/,
  );
});

test('O8 whitespace-only input counts as missing, not as a value', async () => {
  // Without this, "   " would pass the truthiness check and be stored as a
  // company name of three spaces, which the unique index would never catch.
  await assert.rejects(() => svc().submit({ legalName: '   ', ntn: '1-1' }), /Company name is required/);
  await assert.rejects(() => svc().submit({ legalName: 'Acme', ntn: '\t\n ' }), /NTN \/ Tax ID is required/);
});

test('O9 a malformed email is refused', async () => {
  for (const bad of ['not-an-email', 'a@b', 'a b@c.com', '@nope.pk', 'two@@at.pk']) {
    await assert.rejects(
      () => svc().submit({ legalName: 'Acme', ntn: '1-1', contactEmail: bad }),
      /Email is not a valid address/,
      `should refuse ${bad}`,
    );
  }
});

test('O10 an ordinary address is accepted, including the shapes a strict parser would miss', async () => {
  // Over-strict validation on a PUBLIC form rejects real applicants, which is
  // worse than accepting an odd-but-legal address.
  for (const good of ['a@b.co', 'first.last@sub.domain.pk', "o'brien@x.pk", 'a+tag@b.pk']) {
    await svc([{ id: 'i', reference: 'ONB-2026-00001', state: 'Submitted', submitted_at: 'now' }])
      .submit({ legalName: 'Acme', ntn: '1-1', contactEmail: good });
  }
});

test('O11 an unknown category is refused, and the message lists what is allowed', async () => {
  await assert.rejects(
    () => svc(CATEGORY_ROWS).submit({ legalName: 'Acme', ntn: '1-1', categories: 'Underwater Basket Weaving' }),
    /not a known line category/,
  );
  // The failure must be actionable by a human filling a form, and it must name
  // the vocabulary that is actually accepted — D365 item groups.
  await assert.rejects(
    () => svc(CATEGORY_ROWS).submit({ legalName: 'Acme', ntn: '1-1', categories: 'Nonsense' }),
    /Allowed: IT_HARDWARE, OFFICE_SUPPLIES, PROFESSIONAL_SERVICES, FACILITIES/,
  );
});

test('O11b a D365 item group is refused with the reason, not a bare "unknown"', async () => {
  // The confusion that let the earlier bug survive, now pointing the other way.
  // An item group is not an unknown value — it is a value from the WRONG
  // vocabulary, and the message has to say so, because that is the distinction
  // the applicant is making. Bare "not allowed" sends them looking for a typo.
  await assert.rejects(
    () => new OnboardingService(dbWithVocabularies(CATEGORY_ROWS, ITEM_GROUP_ROWS))
      .submit({ legalName: 'Acme', ntn: '1-1', categories: 'IG-OFC' }),
    /is a D365 item group, not a line category/,
  );
});

test('O12 the category is stored as its real code, not the label that was typed', async () => {
  // The prototype's select sends a LABEL ("Office supplies"); vendor rows hold
  // category CODES. Storing the label would make the application unreadable to
  // the RFQ pool and to the admin screens.
  const calls: any[] = [];
  const db = {
    query: async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (/FROM core\.categories/.test(sql)) return { rows: CATEGORY_ROWS, rowCount: CATEGORY_ROWS.length };
      if (/dimension_values/.test(sql)) return { rows: ITEM_GROUP_ROWS, rowCount: ITEM_GROUP_ROWS.length };
      return { rows: [{ id: 'i', reference: 'ONB-2026-00001', state: 'Submitted', submitted_at: 'n' }], rowCount: 1 };
    },
  } as unknown as DbService;
  await new OnboardingService(db).submit({
    legalName: 'Acme', ntn: '1-1', categories: 'Office supplies',
  });
  const insert = calls.find((c) => /INSERT INTO core\.vendor_applications/.test(c.sql));
  assert.equal(insert?.params?.[4], 'OFFICE_SUPPLIES');
});

test('O13 a category code is accepted as-is, in any case', async () => {
  const calls: any[] = [];
  const db = {
    query: async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (/FROM core\.categories/.test(sql)) return { rows: CATEGORY_ROWS, rowCount: CATEGORY_ROWS.length };
      if (/dimension_values/.test(sql)) return { rows: ITEM_GROUP_ROWS, rowCount: ITEM_GROUP_ROWS.length };
      return { rows: [{ id: 'i', reference: 'ONB-2026-00001', state: 'Submitted', submitted_at: 'n' }], rowCount: 1 };
    },
  } as unknown as DbService;
  await new OnboardingService(db).submit({
    legalName: 'Acme', ntn: '1-1', categories: 'office_supplies',
  });
  const insert = calls.find((c) => /INSERT INTO core\.vendor_applications/.test(c.sql));
  assert.equal(insert?.params?.[4], 'OFFICE_SUPPLIES', 'the stored code must be the canonical upper-case one');
});

test('O13b a category name is accepted whatever its case, and omitting one is allowed', async () => {
  const calls: any[] = [];
  const db = {
    query: async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (/FROM core\.categories/.test(sql)) return { rows: CATEGORY_ROWS, rowCount: CATEGORY_ROWS.length };
      if (/dimension_values/.test(sql)) return { rows: ITEM_GROUP_ROWS, rowCount: ITEM_GROUP_ROWS.length };
      return { rows: [{ id: 'i', reference: 'ONB-2026-00001', state: 'Submitted', submitted_at: 'n' }], rowCount: 1 };
    },
  } as unknown as DbService;
  const s = new OnboardingService(db);
  // The MOST RECENT insert — `find` would return the first one forever and
  // every assertion after the first would silently re-test it.
  const inserted = () =>
    calls.filter((c) => /INSERT INTO core\.vendor_applications/.test(c.sql)).pop()?.params?.[4];

  await s.submit({ legalName: 'Acme', ntn: '1-1', categories: 'it hardware' });
  assert.equal(inserted(), 'IT_HARDWARE');
  await s.submit({ legalName: 'Acme', ntn: '1-2', categories: 'FACILITIES' });
  assert.equal(inserted(), 'FACILITIES');
  // And a category may simply be omitted.
  calls.length = 0;
  await s.submit({ legalName: 'Acme', ntn: '1-3' });
  assert.equal(inserted(), null);
});

test('O14 the reference in the response is the ONE the database assigned', async () => {
  // The whole point of W4 §7. If this service ever generated a reference, the
  // applicant would be handed something that is not in the database.
  const r = await svc([{ id: 'i', reference: 'ONB-2026-00442', state: 'Submitted', submitted_at: 'n' }])
    .submit({ legalName: 'Acme', ntn: '1-1' });
  assert.equal(r.reference, 'ONB-2026-00442');
  assert.equal(r.state, 'Submitted');
  assert.equal(r.message, ONBOARDING_SUBMIT_SUCCESS);
  assert.equal(r.statusUrl, '/onboarding/applications/ONB-2026-00442');
});

test('O15 a duplicate LIVE NTN becomes a 409 that leaks nothing', async () => {
  // rowCount 0 with ON CONFLICT DO NOTHING is the duplicate signal. The message
  // must not include the reference or anything about the existing application:
  // this endpoint is public.
  await assert.rejects(
    () => svc([], 0).submit({ legalName: 'Acme', ntn: '1-1' }),
    (e: any) => {
      assert.equal(e.constructor.name, 'ConflictException');
      assert.match(e.message, /already under review/i);
      assert.doesNotMatch(e.message, /ONB-/);
      return true;
    },
  );
});

// ─── Status lookup ──────────────────────────────────────────────────────────

test('O16 a reference alone is refused — the second factor is not optional', async () => {
  // core.seq_vendor_app_ref is SEQUENTIAL by design, so every reference is
  // guessable. Without the email check, ONB-2026-00001..N is a directory of
  // every applicant's company name, NTN and contact email.
  await assert.rejects(
    () => svc([]).status('ONB-2026-00001', null),
    /email address you applied with/i,
  );
  await assert.rejects(
    () => svc([]).status('ONB-2026-00001', '   '),
    /email address you applied with/i,
  );
});

test('O17 a reference with no email match is a 404, not a 403', async () => {
  // A 403 would confirm the reference exists, which is the leak the email check
  // exists to prevent.
  await assert.rejects(
    () => svc([]).status('ONB-2026-00001', 'attacker@evil.test'),
    (e: any) => {
      assert.equal(e.constructor.name, 'NotFoundException');
      assert.doesNotMatch(e.message, /exists|forbidden|unauthor/i);
      return true;
    },
  );
});

test('O18 the status response is a SUBSET — no PII is echoed back', async () => {
  const r = await svc([{
    reference: 'ONB-2026-00001', state: 'Submitted', submitted_at: 'n', reviewed_at: null,
    decision_note: null, reference_note: null,
  }]).status('ONB-2026-00001', 'a@b.co');
  const body = JSON.stringify(r);
  // If these ever come back, the email check is protecting nothing.
  for (const pii of ['legal_name', 'legalName', 'ntn', 'contact_email', 'contactEmail', 'contact_name']) {
    assert.ok(!(pii in r), `${pii} must not be in the status response`);
    assert.doesNotMatch(body, new RegExp(pii), `${pii} leaked into the response body`);
  }
  assert.equal(r.reference, 'ONB-2026-00001');
  assert.equal(r.state, 'Submitted');
  assert.equal(r.pending, true);
});

test('O19 decision_note IS returned — it is the note written FOR the applicant', async () => {
  const r = await svc([{
    reference: 'ONB-2026-00001', state: 'Rejected', submitted_at: 'n', reviewed_at: 'later',
    decision_note: 'Tax registration could not be verified', reference_note: null,
  }]).status('ONB-2026-00001', 'a@b.co');
  assert.equal(r.decisionNote, 'Tax registration could not be verified');
  assert.equal(r.pending, false, 'Rejected is not pending');
});

test('O20 pending tracks the two live states', async () => {
  for (const [state, pending] of [['Submitted', true], ['Under_Review', true], ['Approved', false], ['Rejected', false]] as const) {
    const r = await svc([{
      reference: 'ONB-2026-00001', state, submitted_at: 'n', reviewed_at: null,
      decision_note: null, reference_note: null,
    }]).status('ONB-2026-00001', 'a@b.co');
    assert.equal(r.pending, pending, `${state} -> pending ${pending}`);
  }
});
