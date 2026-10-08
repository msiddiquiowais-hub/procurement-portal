import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api';

export type Session = {
  token: string;
  user: { id: string; email: string; displayName: string; role: string; costCenterIds: string[] };
};

type Ctx = {
  session: Session | null;
  /**
   * False until localStorage has been read. Guards have to wait for this:
   * on a hard navigation the first render sees `session === null` because
   * the token has not been read yet, and a page that redirects on
   * `!session` would bounce a signed-in user to the login screen.
   */
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
};
const SessionCtx = createContext<Ctx>({} as any);

export function SessionProvider({ children }: { children: any }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const raw = typeof window !== 'undefined' ? localStorage.getItem('pk_session') : null;
    if (raw) try { setSession(JSON.parse(raw)); } catch { /* ignore */ }
    setReady(true);
  }, []);

  const login = async (email: string, password: string) => {
    const res = await api.post('/auth/login', { email, password });
    const s: Session = res.data;
    setSession(s);
    localStorage.setItem('pk_session', JSON.stringify(s));
  };

  const logout = () => {
    setSession(null);
    localStorage.removeItem('pk_session');
  };

  return <SessionCtx.Provider value={{ session, ready, login, logout }}>{children}</SessionCtx.Provider>;
}

export function useSession() {
  return useContext(SessionCtx);
}
