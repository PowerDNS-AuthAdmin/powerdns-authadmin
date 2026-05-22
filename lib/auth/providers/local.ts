/**
 * lib/auth/providers/local.ts
 *
 * Local email + password authentication. Verifies a password against the
 * stored Argon2id hash, handles lockout state, and returns a verified
 * identity ready for `startSession()`.
 *
 * Side effects intentional and limited:
 *   - On success: clears failed_login_count + lockedUntil.
 *   - On failure: increments failed_login_count, sets lockedUntil if past
 *     threshold.
 *   - Re-hashes the password if Argon2 parameters have been bumped.
 */

import "server-only";
import {
  findUserByEmail,
  isDisabled,
  isLockedOut,
  recordFailedLogin,
  recordSuccessfulLogin,
  updateUser,
} from "@/lib/db/repositories/users";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/auth/password";
import { getAppSettings } from "@/lib/settings/app-settings";
import type { User } from "@/lib/db/schema";
import type { VerifiedIdentity } from "./types";

/**
 * Cached "constant-time pad" hash used to keep verification timing similar
 * for the user-doesn't-exist path. Generated on first need; never matches a
 * real input. Lazy + memoized so we don't pay the hash cost on cold start —
 * and so the value tracks current Argon2 parameters without a maintenance
 * burden.
 */
let cachedPad: Promise<string> | null = null;
function constantTimePad(): Promise<string> {
  cachedPad ??= hashPassword("powerdns-authadmin/constant-time-pad/do-not-use");
  return cachedPad;
}

export type LocalAuthOutcome =
  | { kind: "ok"; user: User; identity: VerifiedIdentity }
  | { kind: "invalid-credentials" }
  | { kind: "locked-out"; unlockAt: Date }
  | { kind: "disabled" };

/**
 * Verify an email + password pair. Constant-time-ish even when the user
 * doesn't exist (we still do a fake Argon2 verify so timing doesn't leak
 * existence).
 */
export async function authenticateLocal(input: {
  email: string;
  password: string;
  ip: string | null;
}): Promise<LocalAuthOutcome> {
  const user = await findUserByEmail(input.email);

  // No-user path runs a fake verify against a cached pad hash to keep
  // timing similar to the user-exists path. The pad's hash always fails
  // to match real input but takes Argon2-shaped time.
  if (!user) {
    await verifyPassword(await constantTimePad(), input.password);
    return { kind: "invalid-credentials" };
  }

  if (isDisabled(user)) return { kind: "disabled" };
  if (isLockedOut(user)) {
    return { kind: "locked-out", unlockAt: user.lockedUntil! };
  }
  if (!user.passwordHash) {
    // SSO-only user trying local login. Treat as invalid credentials —
    // we don't leak which auth path the user is configured for.
    return { kind: "invalid-credentials" };
  }

  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    // Lockout thresholds are now operator-tunable via the admin
    // Settings page. Default values match the pre-tick
    // hardcoded constants (10 attempts / 15 minutes) so a fresh
    // deployment behaves identically.
    const settings = await getAppSettings();
    const { lockedUntil } = await recordFailedLogin(
      user.id,
      settings.loginLockoutThreshold,
      settings.loginLockoutSeconds,
    );
    if (lockedUntil) return { kind: "locked-out", unlockAt: lockedUntil };
    return { kind: "invalid-credentials" };
  }

  // Successful verify — clear lockout state, bump login timestamps.
  await recordSuccessfulLogin(user.id, input.ip);

  // Opportunistic rehash if parameters were bumped since the hash was made.
  if (needsRehash(user.passwordHash)) {
    const newHash = await hashPassword(input.password);
    await updateUser(user.id, { passwordHash: newHash });
  }

  return {
    kind: "ok",
    user,
    identity: {
      source: "local",
      email: user.email,
      name: user.name ?? undefined,
      emailVerified: user.emailVerifiedAt !== null,
    },
  };
}
