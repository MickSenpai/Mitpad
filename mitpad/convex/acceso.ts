// Convex no tiene usuarios de base de datos: cada función pública recibe el
// token de la app y lo comprueba aquí (variable MITPAD_TOKEN del despliegue).
import { ConvexError } from "convex/values";
import { env } from "./_generated/server";

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
