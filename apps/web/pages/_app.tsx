import type { AppProps } from 'next/app';
import '../styles/globals.css';
import { SessionProvider } from '../lib/session';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <SessionProvider>
      <Component {...pageProps} />
    </SessionProvider>
  );
}
