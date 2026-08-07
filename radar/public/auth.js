(function () {
  'use strict';

  /**
   * Sign-in, by hand, against Supabase's GoTrue REST API.
   *
   * The obvious move is @supabase/supabase-js. This page has no build step and
   * no dependencies — the fonts are self-hosted specifically so nothing is
   * fetched from a CDN — and pulling in a bundled SDK to POST two endpoints
   * would be the largest thing on the page by an order of magnitude. What is
   * actually needed is small: exchange a password for a token, refresh it
   * before it expires, and hand the right headers to fetch.
   *
   * Everything is injected — storage, fetch, clock — so the awkward parts
   * (expiry arithmetic, concurrent refresh) can be tested without a browser or
   * a live project.
   *
   * The session lands in localStorage. That is the same exposure as any
   * signed-in tab, and the alternative (memory only) would mean signing in on
   * every reload of a dashboard whose whole point is being glanceable.
   */

  const root = typeof window !== 'undefined' ? window : globalThis;

  const SESSION_KEY = 'veritas_radar_session';
  /* Refresh this long before the token actually expires. A token that dies
   * mid-request produces a 401 the UI would have to interpret, and the whole
   * point of a margin is to never have to. */
  const REFRESH_MARGIN_MS = 60000;

  /** Pure: does this session need refreshing before it can be used? */
  function needsRefresh(session, nowMs) {
    if (!session || !session.access_token) return false;
    if (!session.expires_at) return true;      // unknown expiry: assume stale
    return session.expires_at - REFRESH_MARGIN_MS <= nowMs;
  }

  /** GoTrue returns expires_in (seconds from now); store an absolute moment so
   *  a session read back tomorrow is judged against the right clock. */
  function sessionFromGrant(grant, nowMs) {
    if (!grant || !grant.access_token) return null;
    return {
      access_token: grant.access_token,
      refresh_token: grant.refresh_token || null,
      expires_at: nowMs + (Number(grant.expires_in) || 3600) * 1000,
      user: grant.user ? { id: grant.user.id, email: grant.user.email } : null
    };
  }

  function createAuthClient({ url, anonKey, storage, fetchFn, now }) {
    const base = String(url || '').replace(/\/$/, '');
    const clock = now || (() => Date.now());
    const doFetch = fetchFn || ((...args) => fetch(...args));
    let refreshing = null;

    const read = () => {
      try {
        const raw = storage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    };
    const write = (session) => {
      try {
        if (session) storage.setItem(SESSION_KEY, JSON.stringify(session));
        else storage.removeItem(SESSION_KEY);
      } catch { /* private browsing, quota — being signed out is survivable */ }
    };

    const post = async (pathname, body) => {
      const response = await doFetch(`${base}/auth/v1${pathname}`, {
        method: 'POST',
        headers: { apikey: anonKey, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error_description || payload?.msg || payload?.error || `sign-in failed (${response.status})`;
        throw new Error(message);
      }
      return payload;
    };

    async function signIn(email, password) {
      const grant = await post('/token?grant_type=password', { email, password });
      const session = sessionFromGrant(grant, clock());
      if (!session) throw new Error('no token returned');
      write(session);
      return session;
    }

    async function signOut() {
      const session = read();
      write(null);
      if (!session?.access_token) return;
      // Best effort: the local session is already gone, so a failure here
      // costs nothing but a server-side token living out its hour.
      try {
        await doFetch(`${base}/auth/v1/logout`, {
          method: 'POST',
          headers: { apikey: anonKey, authorization: `Bearer ${session.access_token}` }
        });
      } catch { /* signed out locally regardless */ }
    }

    /**
     * A usable access token, refreshing first if the current one is close to
     * expiry. Concurrent callers share one refresh: the dashboard fires several
     * authed requests at boot, and without this they would each burn the
     * refresh token, with all but one of them failing.
     */
    async function accessToken() {
      const session = read();
      if (!session) return null;
      if (!needsRefresh(session, clock())) return session.access_token;
      if (!session.refresh_token) { write(null); return null; }
      if (!refreshing) {
        refreshing = (async () => {
          try {
            const grant = await post('/token?grant_type=refresh_token', { refresh_token: session.refresh_token });
            const next = sessionFromGrant(grant, clock());
            write(next);
            return next ? next.access_token : null;
          } catch {
            // A refresh token the server rejects will not start working; treat
            // it as signed out rather than retrying into a loop.
            write(null);
            return null;
          } finally {
            refreshing = null;
          }
        })();
      }
      return refreshing;
    }

    /** Headers for a PostgREST call as the signed-in user, or null. */
    async function headers() {
      const token = await accessToken();
      if (!token) return null;
      return { apikey: anonKey, authorization: `Bearer ${token}` };
    }

    return {
      session: read,
      user: () => read()?.user || null,
      signedIn: () => Boolean(read()?.access_token),
      signIn,
      signOut,
      accessToken,
      headers
    };
  }

  const RadarAuth = { createAuthClient, needsRefresh, sessionFromGrant, SESSION_KEY, REFRESH_MARGIN_MS };

  root.RadarAuth = RadarAuth;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RadarAuth;
  }
})();
