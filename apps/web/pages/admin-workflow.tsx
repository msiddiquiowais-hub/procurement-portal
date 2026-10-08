// Part 7 — the Dynamic Workflow Visual Builder.
//
// A live Mermaid routing diagram plus a reorderable, parameterised step grid
// with a per-step line-rule accordion. Every edit is autosaved to
// workflow.steps_config, which is the SAME table the routing engine reads on
// every PR advance — so a change made here changes the next request's route.
//
// Nothing on this page is decorative. If the config cannot be read the source
// badge says so, and if Mermaid cannot load the raw source is shown instead of
// an empty box.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Shell from '../components/Shell';
import { api, type ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { canSee } from '../components/Shell';
import { buildMermaidFromSteps, type WfStep } from '../lib/wfMermaid';
import {
  LIGHT_ACTOR_ROLES,
  LIGHT_ITEM_CATEGORIES,
  LIGHT_STAGES,
  PREDICATE_VOCABULARY,
  STAGE_LABEL,
  isAmountPredicate,
} from '@procurement/workflow-engine';

type Rule = {
  category?: string[] | string;
  amountOp?: string;
  amountValue?: number;
  routeTo?: string;
  actorRole?: string;
  reason?: string;
};

type BuilderModel = {
  steps: WfStep[];
  managementThreshold: number;
  source: 'db' | 'snapshot' | 'fallback';
  version: number;
};

const AMOUNT_OPS = ['>', '>=', '<', '<=', '=', '!='];

/**
 * Every stage a Target-state select may offer.
 *
 * LIGHT_STAGES is the light flow's vocabulary, but the routing table also holds
 * the Wave 3 governance steps, whose targets (MC_APPROVED, CFO_APPROVED, ...)
 * are NOT in LIGHT_STAGES. A select whose value is not among its options renders
 * blank, which would silently look like an empty field. So the union is taken
 * with STAGE_LABEL, and each row additionally always includes its own current
 * `to` — a value this screen did not anticipate is still preserved on save
 * rather than dropped.
 */
const TARGET_STAGES: Array<{ k: string; label: string }> = (() => {
  const seen = new Map<string, string>();
  for (const s of LIGHT_STAGES) seen.set(s.k, s.label);
  for (const [k, label] of Object.entries(STAGE_LABEL)) {
    if (!seen.has(k)) seen.set(k, label);
  }
  return [...seen.entries()].map(([k, label]) => ({ k, label }));
})();

function targetOptions(currentTo?: string) {
  const opts = [...TARGET_STAGES];
  if (currentTo && !opts.some(o => o.k === currentTo)) {
    opts.push({ k: currentTo, label: currentTo });
  }
  return opts;
}

export default function AdminWorkflow() {
  const { session, ready } = useSession();
  const [model, setModel] = useState<BuilderModel | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; kind: 'ok' | 'err' | 'warn' }>>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [diagramOpen, setDiagramOpen] = useState(true);

  const toastSeq = useRef(0);
  const toast = useCallback((text: string, kind: 'ok' | 'err' | 'warn' = 'ok') => {
    const id = ++toastSeq.current;
    setToasts(t => [...t, { id, text, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000);
  }, []);

  const role = session?.user?.role ?? '';

  // -- load ---------------------------------------------------------------
  const load = useCallback(async () => {
    try {
      const r = await api.get<BuilderModel>('/workflow/config');
      setModel(r.data);
      setLoadErr(null);
    } catch (e: any) {
      setLoadErr(e?.message || 'Could not read the workflow configuration.');
    }
  }, []);

  useEffect(() => {
    if (!ready || !session) return;
    load();
  }, [ready, session, load]);

  // -- persistence --------------------------------------------------------
  /**
   * Autosave. The blueprint persists on every edit ("Save workflow config" is
   * an explicit placeholder), so this is the normal path — not a background
   * job. On a 4xx the server's `errors` array is surfaced verbatim: a rejected
   * config must say WHICH rule is wrong, or an admin cannot fix it.
   */
  const persist = useCallback(async (steps: WfStep[], threshold: number) => {
    setSaving(true);
    try {
      const r = await api.put<BuilderModel & { warnings?: string[] }>('/workflow/config', {
        steps,
        managementThreshold: threshold,
      });
      setModel(r.data);
      setErrors([]);
      // The validator's non-fatal warnings are returned on SUCCESS too, so an
      // admin is told a config was accepted with a caveat rather than being
      // left to discover the problem later.
      setWarnings(Array.isArray(r.data?.warnings) ? r.data.warnings : []);
      return true;
    } catch (e: any) {
      const ae = e as ApiError;
      setErrors(ae?.errors?.length ? ae.errors : [e?.message || 'Save failed.']);
      setWarnings(ae?.warnings || []);
      toast('Not saved — the configuration was rejected.', 'err');
      // Re-read so the grid snaps back to what is actually live rather than
      // showing an edit that never persisted.
      await load();
      return false;
    } finally {
      setSaving(false);
    }
  }, [load, toast]);

  const steps = model?.steps ?? [];
  const threshold = model?.managementThreshold ?? 0;

  /** Returns true when the server accepted the configuration. */
  const commit = useCallback(async (nextSteps: WfStep[], nextThreshold: number): Promise<boolean> => {
    // Optimistic local update so the diagram and grid respond on the keystroke;
    // `persist` reconciles with the server and rolls back a rejection.
    setModel(m => (m ? { ...m, steps: nextSteps, managementThreshold: nextThreshold } : m));
    return persist(nextSteps, nextThreshold);
  }, [persist]);

  // =========================================================================
  // The eleven handlers (blueprint Part 7.10)
  // =========================================================================

  /** 1. lightWorkflowMoveStep — swap with the neighbour and re-save. */
  const lightWorkflowMoveStep = useCallback(async (idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    [next[idx], next[to]] = [next[to], next[idx]];
    next.forEach((s, i) => { s.order = i + 1; });
    await commit(next, threshold);
  }, [steps, threshold, commit]);

  /** 2. lightWorkflowEditStep — shallow-merge a patch onto a step. */
  const lightWorkflowEditStep = useCallback(async (idx: number, patch: Partial<WfStep>) => {
    const next = steps.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    // Clearing conditionValue must remove the key, not store null: the
    // validator treats a null on an amount predicate as "needs a value".
    if ('conditionValue' in patch && (patch.conditionValue === null || patch.conditionValue === undefined)) {
      delete next[idx].conditionValue;
    }
    await commit(next, threshold);
  }, [steps, threshold, commit]);

  /** 3. lightWorkflowAddStep — append a blank, harmless step. */
  const lightWorkflowAddStep = useCallback(async () => {
    const key = `custom_${Date.now()}`;
    const next: WfStep[] = [
      ...steps,
      {
        key,
        name: 'New step',
        from: 'Submitted',
        to: 'IN_PROCUREMENT_REVIEW',
        order: steps.length + 1,
        actorRole: 'system',
        when: 'always',
        canSkip: false,
        requiresCapexOpex: false,
        terminal: false,
      },
    ];
    await commit(next, threshold);
    toast('Step added. Set its source stage and condition.');
  }, [steps, threshold, commit, toast]);

  /** 4. lightWorkflowDeleteStep — confirmed, then spliced. */
  const lightWorkflowDeleteStep = useCallback(async (idx: number) => {
    const step = steps[idx];
    if (!step) return;
    if (typeof window !== 'undefined' && !window.confirm(`Delete step ${step.key}?`)) return;
    const next = steps.filter((_, i) => i !== idx);
    next.forEach((s, i) => { s.order = i + 1; });
    const okDone = await commit(next, threshold);
    if (okDone) toast(`Deleted step ${step.key}.`);
  }, [steps, threshold, commit, toast]);

  /** 5. lightWorkflowAddLineRule — append a seeded rule. */
  const lightWorkflowAddLineRule = useCallback(async (stepIdx: number) => {
    const step = steps[stepIdx];
    if (!step) return;
    const seeded: Rule = {
      category: 'OTHER',
      amountOp: '>',
      amountValue: 0,
      routeTo: step.to || 'IN_HOD_REVIEW',
      actorRole: step.actorRole || 'system',
      reason: '',
    };
    const next = steps.map((s, i) =>
      i === stepIdx ? { ...s, lineRules: [...(s.lineRules || []), seeded] } : s,
    );
    await commit(next, threshold);
  }, [steps, threshold, commit]);

  /** 6. lightWorkflowEditLineRule — shallow-merge a patch onto a rule. */
  const lightWorkflowEditLineRule = useCallback(async (
    stepIdx: number,
    ruleIdx: number,
    patch: Partial<Rule>,
  ) => {
    const next = steps.map((s, i) => {
      if (i !== stepIdx) return s;
      const rules = [...(s.lineRules || [])];
      if (!rules[ruleIdx]) return s;
      rules[ruleIdx] = { ...rules[ruleIdx], ...patch };
      return { ...s, lineRules: rules };
    });
    await commit(next, threshold);
  }, [steps, threshold, commit]);

  /** 7. lightWorkflowDeleteLineRule — splice one rule. */
  const lightWorkflowDeleteLineRule = useCallback(async (stepIdx: number, ruleIdx: number) => {
    const next = steps.map((s, i) => {
      if (i !== stepIdx) return s;
      return { ...s, lineRules: (s.lineRules || []).filter((_, j) => j !== ruleIdx) };
    });
    await commit(next, threshold);
  }, [steps, threshold, commit]);

  /** 8. lightWorkflowSetThreshold — any finite non-negative number. */
  const lightWorkflowSetThreshold = useCallback(async (v: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      toast('The management threshold must be a non-negative number.', 'err');
      return;
    }
    await commit(steps, n);
  }, [steps, commit, toast]);

  /** 9. lightWorkflowSave — an explicit placeholder; every edit already saved. */
  const lightWorkflowSave = useCallback(async () => {
    const okDone = await persist(steps, threshold);
    if (okDone) toast('Workflow config saved.');
  }, [steps, threshold, persist, toast]);

  /** 10. lightWorkflowResetDefaults — restore the canonical table. */
  const lightWorkflowResetDefaults = useCallback(async () => {
    if (typeof window !== 'undefined' && !window.confirm('Reset the routing table to defaults?')) return;
    setSaving(true);
    try {
      const r = await api.post<{ config: BuilderModel; resetWarnings: string[] }>('/workflow/config/reset');
      setModel(r.data.config);
      setErrors([]);
      setWarnings(r.data.resetWarnings || []);
      toast('Reset to defaults.');
    } catch (e: any) {
      toast(e?.message || 'Reset failed.', 'err');
    } finally {
      setSaving(false);
    }
  }, [toast]);

  /** 11. lightWorkflowToggle — a documented NO-OP retained for compatibility. */
  const lightWorkflowToggle = useCallback((_stageKey: string, _enabled: boolean) => {
    toast('Per-stage toggles removed in v2.0.x-workflow-config. Use the up/down buttons to reorder steps instead.', 'warn');
  }, [toast]);

  // =========================================================================
  // The live diagram
  // =========================================================================
  const mermaidSrc = useMemo(
    () => buildMermaidFromSteps(steps, threshold),
    [steps, threshold],
  );
  const [svg, setSvg] = useState<string | null>(null);
  const [diagramNote, setDiagramNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!mermaidSrc) return;
    (async () => {
      try {
        // Client-only: Mermaid touches `document` on import.
        const mod: any = await import('mermaid');
        const mermaid = mod?.default ?? mod;
        mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
        const id = `wf-mermaid-svg-${Date.now()}`;
        const res = await mermaid.render(id, mermaidSrc);
        if (!cancelled) {
          setSvg(res?.svg ?? null);
          setDiagramNote(null);
        }
      } catch (e: any) {
        // The blueprint's contract: the source must stay visible even when
        // Mermaid cannot render. A blank diagram would hide the configuration.
        if (!cancelled) {
          setSvg(null);
          setDiagramNote(
            'Mermaid could not render (not loaded, or the diagram failed to parse). The live source is shown below.',
          );
        }
      }
    })();
    return () => { cancelled = true; };
  }, [mermaidSrc]);

  // =========================================================================
  // Render
  // =========================================================================

  if (!ready) return null;

  if (!session) {
    return (
      <Shell title="Workflow Configuration" screenId="admin-workflow">
        <div className="alert info">Sign in to view the workflow configuration.</div>
      </Shell>
    );
  }

  if (!canSee(role, 'admin-workflow')) {
    return (
      <Shell title="Workflow Configuration" screenId="admin-workflow">
        <div className="alert danger">
          The workflow configuration is visible to Procurement and CS only.
        </div>
      </Shell>
    );
  }

  const diagramCard = (
    <div className="card wf-visual-card">
      <div className="card-h">
        <h3>Visual Workflow Diagram</h3>
        <span className="meta">
          Live render of the routing table &mdash; updates on every grid edit.
        </span>
      </div>
      <div className="card-b">
        <details
          id="wf-visual-details"
          open={diagramOpen}
          onToggle={e => setDiagramOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>
            {diagramOpen ? '▼ Hide visual workflow' : '▶ Show visual workflow'}
            <span className="wf-visual-sub">
              regenerated live from the grid below
            </span>
          </summary>
          <div id="wf-mermaid-container" data-source={mermaidSrc}>
            {svg ? (
              <div className="wf-mermaid-wrap" dangerouslySetInnerHTML={{ __html: svg }} />
            ) : (
              <pre className="wf-mermaid-fallback">{mermaidSrc}</pre>
            )}
          </div>
          {diagramNote && (
            <p className="wf-visual-meta">
              {diagramNote}
            </p>
          )}
        </details>
      </div>
    </div>
  );

  if (loadErr) {
    return (
      <Shell title="Workflow Configuration" screenId="admin-workflow" preTitle={diagramCard}>
        <div className="alert danger">
          <b>Could not read the workflow configuration.</b>
          <div style={{ marginTop: 6 }}>{loadErr}</div>
          <div className="btn-row">
            <button className="btn" onClick={load}>Retry</button>
          </div>
        </div>
      </Shell>
    );
  }

  if (!model) {
    return (
      <Shell title="Workflow Configuration" screenId="admin-workflow" preTitle={diagramCard}>
        <div className="card"><div className="card-b empty-state">Loading workflow configuration&hellip;</div></div>
      </Shell>
    );
  }

  return (
    <Shell
      title="Workflow Configuration"
      screenId="admin-workflow"
      preTitle={diagramCard}
      actions={
        <>
          <span className={`wf-source ${model.source}`} title="Where this configuration is being read from">
            {model.source === 'db' ? 'live from database' : model.source}
          </span>
          <span className="wf-save-state">{saving ? 'saving…' : 'all changes autosaved'}</span>
        </>
      }
    >
      <p className="page-sub" style={{ marginTop: -6 }}>
        Edit the <b>WORKFLOW_STEPS_CONFIG</b> array. The engine reads this table on every
        PR advance and walks the steps in <b>order</b>, taking the first step whose
        <b> Condition</b> matches the request. Use the up/down buttons to reorder steps,
        set a <b>Condition Value</b> for amount-based conditions, and add <b>Line rules</b>
        to route individual lines by category and amount &mdash; mixed-category PRs
        auto-split into child PRs.
      </p>

      {errors.length > 0 && (
        <div className="alert danger mb-4">
          <div>
            <b>Not saved.</b> The engine could not honour this configuration, so the
            live table is unchanged:
            <ul style={{ margin: '6px 0 0 18px' }}>
              {errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="alert warn mb-4">
          <div>
            <b>Saved, with warnings.</b>
            <ul style={{ margin: '6px 0 0 18px' }}>
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        </div>
      )}

      {/* ---------------- 3 · the grid ---------------- */}
      <div className="card mb-4">
        <div className="card-h">
          <h3>Lightweight PR routing steps</h3>
          <span className="meta">{steps.length} step{steps.length === 1 ? '' : 's'}</span>
          <button className="btn sm" onClick={lightWorkflowAddStep}>+ Add step</button>
        </div>
        <div className="card-b" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="wf-grid">
            <thead>
              <tr>
                <th>Order</th>
                <th>ID</th>
                <th>Name</th>
                <th>Actor role</th>
                <th>From</th>
                <th>Target state</th>
                <th>Condition</th>
                <th>Condition Value</th>
                <th>Skip?</th>
                <th>CAPEX/OPEX?</th>
                <th>Type</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {steps.map((step, i) => {
                const amt = isAmountPredicate(step.when);
                const rules = step.lineRules || [];
                return (
                  <StepRows
                    key={step.key}
                    step={step}
                    index={i}
                    total={steps.length}
                    amt={amt}
                    rules={rules}
                    onMove={lightWorkflowMoveStep}
                    onEdit={lightWorkflowEditStep}
                    onDelete={lightWorkflowDeleteStep}
                    onAddRule={lightWorkflowAddLineRule}
                    onEditRule={lightWorkflowEditLineRule}
                    onDeleteRule={lightWorkflowDeleteLineRule}
                    onToggle={lightWorkflowToggle}
                  />
                );
              })}
              {steps.length === 0 && (
                <tr><td colSpan={12} className="wf-dash" style={{ padding: 16 }}>
                  The routing table is empty. Add a step, or reset to defaults.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------- 4 · threshold ---------------- */}
      <div className="card mb-4">
        <div className="card-h">
          <h3>Routing threshold</h3>
        </div>
        <div className="card-b">
          <div className="field-row" style={{ maxWidth: 320 }}>
            <label className="field">
              <span className="lbl">Management gate threshold (PKR)</span>
              <ThresholdInput
                value={threshold}
                onCommit={lightWorkflowSetThreshold}
              />
            </label>
          </div>
          <p className="text-sm text-mute" style={{ marginTop: 10, maxWidth: 720 }}>
            PRs with an estimated amount at or above this value route to Management
            after Finance. Fast-track low/ceiling knobs have been removed per the
            enterprise blueprint &mdash; every PR follows the configured happy path or
            its line-rule targets.
          </p>
          <div className="btn-row">
            <button className="btn primary" onClick={lightWorkflowSave} disabled={saving}>
              Save workflow config
            </button>
            <button className="btn danger" onClick={lightWorkflowResetDefaults} disabled={saving}>
              Reset to defaults
            </button>
          </div>
        </div>
      </div>

      {/* ---------------- 5 · zero-hardcoding notice ---------------- */}
      <div className="alert info">
        <div>
          <b>Zero hardcoding:</b> every routing decision is read from this table. Actor
          names are resolved by <code>pr.costCenter</code> against the actor registry.
          Per-line rules split mixed-category PRs into child PRs without any department
          logic in the code. Available item categories:{' '}
          {LIGHT_ITEM_CATEGORIES.map((c: any) => (
            <span key={c.id} className="chip static mono" style={{ marginRight: 6 }}>{c.id}</span>
          ))}
        </div>
      </div>

      <div className="wf-toasts">
        {toasts.map(t => (
          <div key={t.id} className={`wf-toast ${t.kind === 'ok' ? '' : t.kind}`}>{t.text}</div>
        ))}
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// One step: the grid row plus its line-rules accordion sub-row.
// ---------------------------------------------------------------------------

function StepRows(props: {
  step: WfStep;
  index: number;
  total: number;
  amt: boolean;
  rules: Rule[];
  onMove: (i: number, d: -1 | 1) => void;
  onEdit: (i: number, p: Partial<WfStep>) => void;
  onDelete: (i: number) => void;
  onAddRule: (i: number) => void;
  onEditRule: (s: number, r: number, p: Partial<Rule>) => void;
  onDeleteRule: (s: number, r: number) => void;
  onToggle: (stage: string, on: boolean) => void;
}) {
  const { step, index, total, amt, rules } = props;
  // Open by default when the step already carries rules, per the blueprint.
  const [open, setOpen] = useState(rules.length > 0);

  const opts = targetOptions(step.to);
  const fromOpts = [{ k: '*', label: 'Any stage' }, ...opts];

  return (
    <>
      <tr data-step={step.key}>
        <td className="wf-narrow">
          <div className="wf-move">
            <button
              onClick={() => props.onMove(index, -1)}
              disabled={index === 0}
              title="Move up"
              aria-label={`Move ${step.key} up`}
            >▲</button>
            <button
              onClick={() => props.onMove(index, 1)}
              disabled={index === total - 1}
              title="Move down"
              aria-label={`Move ${step.key} down`}
            >▼</button>
          </div>
        </td>
        <td className="mono wf-id">{step.key}</td>
        <td>
          <input
            type="text"
            value={step.name ?? ''}
            style={{ width: '100%' }}
            onChange={e => props.onEdit(index, { name: e.target.value })}
          />
        </td>
        <td>
          <select
            className="wf-actor"
            value={step.actorRole ?? 'system'}
            onChange={e => props.onEdit(index, { actorRole: e.target.value })}
          >
            {LIGHT_ACTOR_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </td>
        <td>
          <select
            className="wf-to"
            value={step.from ?? '*'}
            onChange={e => props.onEdit(index, { from: e.target.value })}
          >
            {fromOpts.map(o => <option key={o.k} value={o.k}>{o.label}</option>)}
          </select>
        </td>
        <td>
          <select
            className="wf-to"
            value={step.to}
            onChange={e => props.onEdit(index, { to: e.target.value })}
          >
            {opts.map(o => <option key={o.k} value={o.k}>{o.label}</option>)}
          </select>
        </td>
        <td>
          <select
            className="wf-when"
            value={step.when ?? 'always'}
            onChange={e => props.onEdit(index, { when: e.target.value })}
          >
            {PREDICATE_VOCABULARY.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </td>
        <td className="wf-narrow">
          {amt ? (
            <input
              className="wf-cond"
              type="number"
              min={0}
              step={1}
              value={step.conditionValue ?? ''}
              onChange={e => {
                const raw = e.target.value;
                props.onEdit(index, {
                  conditionValue: raw === '' ? null : Number(raw),
                });
              }}
            />
          ) : (
            <span className="wf-dash">—</span>
          )}
        </td>
        <td className="wf-narrow" style={{ textAlign: 'center' }}>
          <input
            type="checkbox"
            checked={step.canSkip === true}
            aria-label={`Skip ${step.key}`}
            onChange={e => props.onEdit(index, { canSkip: e.target.checked })}
          />
        </td>
        <td className="wf-narrow" style={{ textAlign: 'center' }}>
          <input
            type="checkbox"
            checked={step.requiresCapexOpex === true}
            title="Render per-line CAPEX/OPEX classification UI on this step"
            aria-label={`CAPEX/OPEX on ${step.key}`}
            onChange={e => props.onEdit(index, { requiresCapexOpex: e.target.checked })}
          />
        </td>
        <td className="wf-narrow">
          {step.terminal
            ? <span className="pill danger">terminal</span>
            : <span className="wf-dash">step</span>}
        </td>
        <td className="wf-narrow">
          <button
            className="wf-del"
            onClick={() => props.onDelete(index)}
            title="Delete step"
            aria-label={`Delete step ${step.key}`}
          >×</button>
        </td>
      </tr>

      <tr className="wf-rules-row">
        <td colSpan={12}>
          <details open={open} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>
              Line rules for this step ({rules.length})
              <span className="wf-rules-sub">
                per-line category + amount rules; if multiple distinct targets emerge, the PR is split into child PRs.
              </span>
            </summary>
            <div className="wf-rules-body">
              {rules.length === 0 ? (
                <div className="wf-rules-empty">
                  No rules. Engine will fall back to the step&rsquo;s own target stage and actor.
                </div>
              ) : (
                <table className="wf-rule-table">
                  <thead>
                    <tr>
                      <th>Category (multi)</th>
                      <th>Amount op</th>
                      <th>Amount value</th>
                      <th>routeTo</th>
                      <th>actorRole</th>
                      <th>reason</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((r, ri) => (
                      <tr key={ri}>
                        <td>
                          <select
                            className="wf-cat"
                            multiple
                            value={Array.isArray(r.category) ? r.category : r.category ? [r.category] : []}
                            onChange={e => {
                              const picked = Array.from(e.target.selectedOptions).map(o => o.value);
                              props.onEditRule(index, ri, { category: picked });
                            }}
                          >
                            {LIGHT_ITEM_CATEGORIES.map((c: any) => (
                              <option key={c.id} value={c.id}>{c.id}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            value={r.amountOp ?? '>'}
                            onChange={e => props.onEditRule(index, ri, { amountOp: e.target.value })}
                          >
                            {AMOUNT_OPS.map(op => <option key={op} value={op}>{op}</option>)}
                          </select>
                        </td>
                        <td>
                          <input
                            className="wf-amt"
                            type="number"
                            min={0}
                            step={1}
                            value={r.amountValue ?? ''}
                            onChange={e => {
                              const raw = e.target.value;
                              props.onEditRule(index, ri, {
                                amountValue: raw === '' ? undefined : Number(raw),
                              });
                            }}
                          />
                        </td>
                        <td>
                          <select
                            value={r.routeTo ?? step.to}
                            onChange={e => props.onEditRule(index, ri, { routeTo: e.target.value })}
                          >
                            {targetOptions(r.routeTo ?? step.to).map(o => (
                              <option key={o.k} value={o.k}>{o.label}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            value={r.actorRole ?? 'system'}
                            onChange={e => props.onEditRule(index, ri, { actorRole: e.target.value })}
                          >
                            {LIGHT_ACTOR_ROLES.map(ar => <option key={ar} value={ar}>{ar}</option>)}
                          </select>
                        </td>
                        <td>
                          <input
                            className="wf-reason"
                            type="text"
                            value={r.reason ?? ''}
                            placeholder="why this rule exists (shows in the audit trail)"
                            onChange={e => props.onEditRule(index, ri, { reason: e.target.value })}
                          />
                        </td>
                        <td>
                          <button
                            className="wf-del"
                            onClick={() => props.onDeleteRule(index, ri)}
                            title="Delete line rule"
                            aria-label={`Delete line rule ${ri + 1} on ${step.key}`}
                          >×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="btn-row" style={{ marginTop: 10, paddingTop: 10 }}>
                <button className="btn sm" onClick={() => props.onAddRule(index)}>
                  + Add line rule
                </button>
              </div>
            </div>
          </details>
        </td>
      </tr>
    </>
  );
}

/**
 * A number input that only commits on blur or Enter.
 *
 * Committing on every keystroke would fire a save per digit — typing 1,000,000
 * would put seven intermediate values through the validator, and a partially
 * typed number like "1e" would be rejected mid-keystroke.
 */
function ThresholdInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(String(value));
  }, [value, dirty]);

  return (
    <input
      type="number"
      min={0}
      step={1}
      value={draft}
      style={{ width: '100%' }}
      onChange={e => { setDraft(e.target.value); setDirty(true); }}
      onBlur={() => {
        if (dirty) { setDirty(false); onCommit(Number(draft)); }
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
