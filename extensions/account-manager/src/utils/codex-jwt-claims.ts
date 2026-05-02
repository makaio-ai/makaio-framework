import { decodeJwtPayload } from './jwt.js';
import type { CodexAuth, IdTokenIdentity } from '../sources/codex-source-types.js';

/**
 * Extracts the identity fields from decoded id_token JWT claims.
 * @param claims - Decoded id_token JWT claims.
 * @returns Identity fields from JWT claims.
 */
export function extractIdTokenIdentity(claims: Record<string, unknown>): IdTokenIdentity {
  const auth = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  const name = typeof claims.name === 'string' && claims.name.length > 0 ? claims.name : null;
  const email = typeof claims.email === 'string' && claims.email.length > 0 ? claims.email : null;
  const rawPlanType = auth?.chatgpt_plan_type;
  const planType = typeof rawPlanType === 'string' && rawPlanType.length > 0 ? rawPlanType : undefined;
  return { name, email, planType };
}

/**
 * Extracts the user-scoped `chatgpt_user_id` from decoded JWT claims.
 * @param claims - Decoded id_token JWT claims.
 * @returns The user ID string, or null when absent.
 */
export function extractChatgptUserId(claims: Record<string, unknown>): string | null {
  const auth = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  const userId = auth?.chatgpt_user_id ?? auth?.user_id;
  return typeof userId === 'string' && userId.length > 0 ? userId : null;
}

/**
 * Returns false when the id_token's `chatgpt_account_id` does not match
 * `tokens.account_id`, indicating a mixed-state auth file where the JWT
 * was issued for a different org than the one recorded in the token bag.
 * @param claims - Decoded id_token JWT claims.
 * @param accountId - The `tokens.account_id` from the auth file, if present.
 * @returns Whether the id_token is internally consistent with the auth file.
 */
export function isIdTokenConsistent(claims: Record<string, unknown>, accountId: string | undefined): boolean {
  if (typeof accountId !== 'string' || accountId.length === 0) return true;
  const auth = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  const jwtAccountId = auth?.chatgpt_account_id;
  return typeof jwtAccountId !== 'string' || jwtAccountId.length === 0 || jwtAccountId === accountId;
}

/**
 * Builds the compound `accountId:userId` fingerprint for ChatGPT OAuth mode.
 * @param parsed - Parsed Codex auth payload.
 * @returns Compound fingerprint, or null when required fields are missing.
 */
export function buildChatgptFingerprint(parsed: CodexAuth): string | null {
  const accountId = parsed.tokens?.account_id;
  if (typeof accountId !== 'string' || accountId.length === 0) return null;

  const idToken = parsed.tokens?.id_token;
  if (typeof idToken !== 'string') return accountId;
  const claims = decodeJwtPayload(idToken);
  if (!claims) return accountId;

  const userId = extractChatgptUserId(claims);
  return userId ? `${accountId}:${userId}` : accountId;
}
