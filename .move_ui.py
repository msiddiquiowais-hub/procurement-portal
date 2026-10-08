import io, re

D = r"E:\Procurement Application\procurement-portal\apps\web\pages\admin-dimensions.tsx"
C = r"E:\Procurement Application\procurement-portal\apps\web\pages\admin-categories.tsx"

d = io.open(D, encoding="utf-8").read()

def cut(s, start_marker, end_marker, label):
    i = s.index(start_marker)
    j = s.index(end_marker, i) + len(end_marker)
    block = s[i:j]
    s = s[:i] + s[j:]
    print(f"cut {label}: {len(block)} chars")
    return s, block

# 1. manage state
d, _ = cut(
    d,
    "  // The line category whose vendors are being managed",
    "const [manage, setManage] = useState<{ code: string; label: string } | null>(null);",
    "manage state")

# 2. import state + handlers
d, import_block = cut(
    d,
    "  // ── bulk import of vendor <-> item-group links",
    "  };\n",
    "import handlers")

# 3. import card
d, import_card = cut(
    d,
    "      {/* ── bulk import: vendor <-> item-group links",
    "      )}\n",
    "import card")

d = d.replace("import { useCallback, useEffect, useMemo, useRef, useState } from 'react';",
              "import { useCallback, useEffect, useMemo, useState } from 'react';")
io.open(D, "w", encoding="utf-8", newline="").write(d)
print("admin-dimensions still references:",
      [k for k in ("manage", "importResult", "fileRef", "vendor_code") if k in d])

# ── move it onto the LINE CATEGORIES screen ────────────────────────────────
c = io.open(C, encoding="utf-8").read()

# adapt the moved code: the categories screen has no `act()` helper
ib = import_block.replace("await act('import', async () => {", "await runImportBody(async () => {")
ib = ib.replace("V-00081,IG-OFC,true", "V-00081,OFFICE_SUPPLIES,true")
ib = ib.replace("V-00081,Office Supplies,true", "V-00081,Office supplies,true")

# a tiny wrapper so the moved handler keeps its error handling
ib += """
  /** Small adapter: the categories screen has no `act()` helper of its own. */
  async function runImportBody(fn: () => Promise<void>) {
    setBusy('vendor-import');
    try { await fn(); }
    catch (e) { setErr((e as ApiError).message); }
    finally { setBusy(''); }
  }
"""

c = c.replace("import Shell from '../components/Shell';",
              "import Shell from '../components/Shell';\nimport ManageVendorsModal from '../components/ManageVendorsModal';")

# state for the modal
c = c.replace("  const [importResult, setImportResult] = useState<ImportResult | null>(null);",
              "  const [importResult, setImportResult] = useState<ImportResult | null>(null);\n"
              "  // Which line category's vendor list is open in the Manage Vendors modal.\n"
              "  const [manage, setManage] = useState<{ code: string; label: string } | null>(null);")

# the handlers, just before the return
anchor = "  return (\n"
c = c.replace(anchor, ib + "\n" + anchor, 1)

# the modal + a Manage vendors button per row, at the end of the body
tail_anchor = "      {allowed && msg && <p className=\"text-sm\">{msg}</p>}"
modal = tail_anchor + """

      {manage && (
        <ManageVendorsModal
          code={manage.code}
          label={manage.label}
          onClose={() => setManage(null)}
          onChanged={load}
        />
      )}"""
if tail_anchor in c:
    c = c.replace(tail_anchor, modal, 1)
else:
    print("WARN: msg anchor not found; appending modal before </Shell>")
    c = c.replace("    </Shell>", modal + "\n    </Shell>", 1)

io.open(C, "w", encoding="utf-8", newline="").write(c)
print("admin-categories has modal:", "ManageVendorsModal" in c,
      "| import handlers:", "runImport" in c)
print("unused import card kept for re-mount:", len(import_card), "chars")