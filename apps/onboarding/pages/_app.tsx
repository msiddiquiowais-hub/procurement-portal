import type { AppProps } from 'next/app';
import '../styles/globals.css';

/**
 * The onboarding app is a single PUBLIC page with no session, so _app only has
 * to bring in the stylesheet.
 *
 * The prototype's `screen-public` body class is deliberately NOT reproduced here.
 * It exists upstream because that one page hosts three mutually exclusive shells
 * and needs a switch; this app has one shell, so `.public-screen` simply displays
 * (see styles/globals.css). Copying the toggle would be importing a mechanism
 * this app has nothing to toggle.
 */
export default function OnboardingApp({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
