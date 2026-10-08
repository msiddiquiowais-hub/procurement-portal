import { useState } from 'react';
import { useRouter } from 'next/router';
import { useSession } from '../lib/session';

export default function Login() {
  const { session, login } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState('requester@pakboxes.pk');
  const [password, setPassword] = useState('demo');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session) {
    if (typeof window !== 'undefined') router.replace('/dashboard');
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const pw = (password || '').trim() || 'demo';
      await login(email, pw);
      router.push('/dashboard');
    } catch (e: any) {
      setErr(e.message || 'login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-shell">
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div className="brand-logo lg">P</div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--navy)', marginBottom: 4 }}>Procurement Portal</h1>
          <p className="text-mute text-sm">Sign in to continue</p>
        </div>
        <div className="card">
          <div className="card-b">
            <form onSubmit={submit}>
              <label className="field">
                <span className="lbl">Email <span className="req">*</span></span>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@pakboxes.pk" required />
              </label>
              <label className="field">
                <span className="lbl">Password <span className="req">*</span></span>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
              </label>
              {err && <div className="alert danger" style={{ marginTop: 10, marginBottom: 0 }}>{err}</div>}
              <button type="submit" className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }} disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </div>
        </div>
        <p className="text-sm text-mute" style={{ textAlign: 'center', marginTop: 16, lineHeight: 1.55 }}>
          Demo: <code>requester@pakboxes.pk</code> / <code>demo</code> &middot; or any from the list below.<br />
          <b>Department HODs</b> (the approval role):{' '}
          <code>hod.sales@</code> &middot; <code>hod.it@</code> &middot; <code>hod.finance@</code> &middot;{' '}
          <code>hod.hr@</code> &middot; <code>hod.operations@</code> <code>(all @pakboxes.pk)</code><br />
          <b>Other roles</b>: <code>procurement@</code> &middot; <code>finance@</code> &middot; <code>cfo@</code>
          {' '}<code>@pakboxes.pk</code> &middot; <code>admin@pakboxes.pk</code> (alias for all internal roles)<br />
          <span className="text-xs">
            Note: <code>hod.finance@</code> is the Finance HOD; <code>finance@</code> is the Finance
            Officer. Same department, different permissions — approvals belong to the <code>hod.</code> account.
          </span>
        </p>
      </div>
    </div>
  );
}