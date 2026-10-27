// Convex no tiene usuarios de base de datos: cada función pública recibe el
// token de la app y lo comprueba aquí (variable MITPAD_TOKEN del despliegue).
import { ConvexError } from "convex/values";
import { env } from "./_generated/server";

export const USER_ID_LEGADO = "f7c9a64f-efa2-4f29-8822-b1b6a1c2030c";

export function userIdPersonal(): string {
  return env.MITPAD_USER_ID ?? USER_ID_LEGADO;
}

function iguales(a: string, b: string): boolean {
  // Comparación en tiempo constante (que el tiempo no delate cuánto acierta)
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

export function exigirToken(token: string): void {
  const esperado = env.MITPAD_TOKEN;
  if (!esperado || !iguales(token, esperado)) throw new ConvexError("Token inválido.");
}

export function exigirUsuario(userId: string): void {
  if (!iguales(userId, userIdPersonal())) throw new ConvexError("La operación no pertenece al usuario de Mitpad.");
}

export async function hashAgentApiKey(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function keyFromRequest(request: Request): Promise<string | null> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const key = authorization.slice(7).trim();
  return key.length >= 32 && key.length <= 200 ? key : null;
}
