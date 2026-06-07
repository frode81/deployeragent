import { timingSafeEqual } from "crypto";

export function isAgentAuthRequired(): boolean {
  if (process.env.AGENT_SECRET?.trim()) return true;
  return (
    process.env.NODE_ENV === "production" || process.env.AGENT_REQUIRE_SECRET === "true"
  );
}

export function assertAgentSecretConfigured(): void {
  if (isAgentAuthRequired() && !process.env.AGENT_SECRET?.trim()) {
    console.error(
      "[agent] AGENT_SECRET mangler — avviser oppstart i produksjon. Sett en sterk tilfeldig verdi i infrastructure/.env."
    );
    process.exit(1);
  }
}

export function verifyAgentToken(header: string | string[] | undefined): boolean {
  const expected = process.env.AGENT_SECRET?.trim();
  if (!expected) return true;

  const token = Array.isArray(header) ? header[0] : header;
  if (!token || typeof token !== "string") return false;

  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
