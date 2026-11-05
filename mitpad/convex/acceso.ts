// Utilidades de acceso. La web autentica con Convex Auth (ver webAuth.ts) y los
// agentes con claves individuales; no queda ningún token compartido.
import { env } from "./_generated/server";

export const USER_ID_LEGADO = "f7c9a64f-efa2-4f29-8822-b1b6a1c2030c";

export function userIdPersonal(): string {
  return env.MITPAD_USER_ID ?? USER_ID_LEGADO;
}

export async function hashAgentApiKey(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function keyFromRequest(request: Request): Promise<string | null> {
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const key = match[1].trim();
  return key.length >= 32 && key.length <= 200 ? key : null;
}
