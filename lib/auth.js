/* ============================================================
   Flow — access gate
   Flow has no user accounts; it is one person's planner. Deployed
   to a public URL that means anyone who guesses the address can
   read and edit the to dos, so a password is required before the
   API answers to anyone.

   Set APP_PASSWORD to switch this on. Left unset the gate is open,
   which is the right default for http://localhost but is refused
   in production — see assertProductionSafe().
   ============================================================ */

import crypto from 'crypto';

const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET   = process.env.SESSION_SECRET || PASSWORD;
const COOKIE   = 'flow_session';
const MAX_AGE  = 60 * 60 * 24 * 30;             // 30 days

export const authEnabled = () => !!PASSWORD;

/** Opaque, constant-length token. Nothing about the password is recoverable. */
function mintToken() {
  return crypto.createHmac('sha256', SECRET).update('flow-session-v1').digest('hex');
}

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function hasSession(req) {
  if (!authEnabled()) return true;
  const tok = readCookie(req, COOKIE);
  return !!tok && timingSafeEqual(tok, mintToken());
}

export function checkPassword(candidate) {
  return authEnabled() && timingSafeEqual(
    crypto.createHash('sha256').update(String(candidate)).digest('hex'),
    crypto.createHash('sha256').update(PASSWORD).digest('hex'),
  );
}

export function issueSession(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${mintToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`);
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Gate for everything that reads or writes data. */
export function requireAuth(req, res, next) {
  if (hasSession(req)) return next();
  res.status(401).json({ error: 'Not signed in', needsAuth: true });
}

/**
 * A calendar client cannot sign in, so the .ics feed is reached with a
 * secret in the query string instead. Without CALENDAR_KEY the feed simply
 * follows the normal session rule.
 */
export function calendarAllowed(req) {
  if (hasSession(req)) return true;
  const key = process.env.CALENDAR_KEY;
  return !!key && typeof req.query.key === 'string' && timingSafeEqual(req.query.key, key);
}

/**
 * Refuse to serve an unprotected deployment. Getting this wrong publishes
 * someone's planner to the open web, so it fails loudly at boot rather than
 * quietly at request time.
 */
export function assertProductionSafe() {
  const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  if (isProd && !authEnabled()) {
    throw new Error(
      'APP_PASSWORD is not set. Flow has no accounts, so without it this deployment ' +
      'would let anyone with the URL read and edit your to dos. Set APP_PASSWORD in ' +
      'the Vercel project settings and redeploy.');
  }
}
