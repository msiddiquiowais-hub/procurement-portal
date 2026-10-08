// Item categories — port of the prototype's LIGHT_ITEM_CATEGORIES and
// _lightResolveLineCategory. Source of truth for line-rule matching.

import type { ItemCategory, PrLine } from './types';

export type ItemCategoryDef = {
  id: ItemCategory;
  label: string;
  desc: string;
};

export const LIGHT_ITEM_CATEGORIES: ItemCategoryDef[] = [
  { id: 'IT_HARDWARE', label: 'IT hardware', desc: 'Laptops, desktops, servers, networking equipment.' },
  { id: 'IT_SOFTWARE', label: 'IT software', desc: 'Licensed software, SaaS subscriptions, cloud services.' },
  { id: 'OFFICE_SUPPLIES', label: 'Office supplies', desc: 'Stationery, printer consumables, general consumables.' },
  { id: 'WAREHOUSE_ACCESSORY', label: 'Warehouse accessory', desc: 'Docks, cables, bags, mounts -- bundled or standalone.' },
  { id: 'MACHINERY', label: 'Machinery / plant', desc: 'Production-line machinery, tooling, heavy equipment.' },
  { id: 'PROFESSIONAL_SERVICES', label: 'Professional services', desc: 'Consultancy, audit, legal, training.' },
  { id: 'FACILITIES', label: 'Facilities / FM', desc: 'HVAC, plumbing, electrical, building maintenance.' },
  { id: 'MARKETING', label: 'Marketing / branding', desc: 'Campaigns, events, collateral, signage.' },
  { id: 'OTHER', label: 'Other', desc: 'Catch-all when no category fits.' },
];

export const LIGHT_ITEM_CATEGORY_LABEL: Record<string, string> =
  Object.fromEntries(LIGHT_ITEM_CATEGORIES.map(c => [c.id, c.label]));

export const LIGHT_ITEM_CATEGORY_IDS: string[] = LIGHT_ITEM_CATEGORIES.map(c => c.id);

/**
 * Resolve a line's routing category.
 *
 * Precedence matches the prototype exactly:
 *   1. explicit `line.category`
 *   2. `line.itemCategory` (the application's persisted category)
 *   3. inference from `financialDimensions.ItemGroup`
 *   4. 'OTHER'
 */
export function resolveLineCategory(line: PrLine | null | undefined): ItemCategory {
  if (!line) return 'OTHER';

  const explicit = (line.category || line.itemCategory || '').trim();
  if (explicit) return explicit as ItemCategory;

  const dims = line.financialDimensions || {};
  const ig = (dims.ItemGroup || '').toUpperCase();

  if (ig.includes('LAPTOP') || ig.includes('DESKTOP') || ig.includes('SERVER')) return 'IT_HARDWARE';
  if (ig.includes('ACC')) return 'WAREHOUSE_ACCESSORY';
  if (ig.includes('OFFICE') || ig.includes('STAT')) return 'OFFICE_SUPPLIES';
  if (ig.includes('MACH') || ig.includes('TOOL')) return 'MACHINERY';
  if (ig.includes('SVC') || ig.includes('CONSULT')) return 'PROFESSIONAL_SERVICES';
  if (ig.includes('FM') || ig.includes('BLDG')) return 'FACILITIES';
  if (ig.includes('MKT') || ig.includes('BRAND')) return 'MARKETING';

  return 'OTHER';
}

/** A line's total: explicit `amount`, else qty × unitPrice. */
export function lineTotal(line: PrLine | null | undefined): number {
  if (!line) return 0;
  if (Number.isFinite(line.amount)) return Number(line.amount);
  return (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
}

/**
 * True when a line's total is not actually established.
 *
 * A line with no unit price is a line nobody has costed yet. `lineTotal()`
 * reports that as 0, which is the right number for arithmetic and the wrong
 * one for a rule test: a line rule of the form "amount < 50000" would match it
 * and route the line down the cheap path on the strength of a number nobody
 * entered. See lineRuleMatches, which fails closed on an unknown total.
 *
 * An explicit 0 is NOT unknown — same reasoning as predicates.amountUnknown.
 */
export function lineAmountUnknown(line: PrLine | null | undefined): boolean {
  if (!line) return true;
  if (Number.isFinite(line.amount)) return false;
  const price = line.unitPrice;
  return price === null || price === undefined || !Number.isFinite(Number(price));
}
