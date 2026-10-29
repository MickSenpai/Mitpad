import React, { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexAuthProvider, useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export type AuthSession = {
  token: string | null;
  email: string | null;
  signOut: () => Promise<void>;
};
type AuthCallback = (session: AuthSession) => void | Promise<void>;

function safeAuthMessage(reason: unknown): string {
  const detail = reason instanceof Error ? reason.message : String(reason);
  if (detail.includes("InvalidAccountId")) return "No encontramos una cuenta de acceso con ese correo. Revisa la dirección o crea una cuenta para continuar.";
  if (detail.includes("InvalidSecret")) return "El correo o la contraseña no coinciden. Revísalos e inténtalo de nuevo.";
  if (detail.includes("TooManyFailedAttempts")) return "Hubo varios intentos fallidos. Espera un momento antes de volver a intentarlo.";
  if (detail.includes("Ingresa un correo válido.")) return "Ingresa un correo electrónico válido.";
  if (detail.includes("La contraseña debe tener al menos 10 caracteres.")) return "La contraseña debe tener al menos 10 caracteres.";
  if (detail.includes("La contraseña no puede superar 128 caracteres.")) return "La contraseña no puede superar 128 caracteres.";
  if (/failed to fetch|networkerror|network request failed/i.test(detail)) return "No se pudo conectar con el servicio de acceso. Revisa tu conexión e inténtalo de nuevo.";
  return "No se pudo completar el acceso. Revisa tus datos e inténtalo de nuevo.";
}

function PasswordForm({ onSession }: { onSession: AuthCallback }) {
  const { signIn, signOut } = useAuthActions();
  const { isLoading, isAuthenticated, fetchAccessToken } = useConvexAuth();
  const profile = useQuery(api.auth.currentUser, isAuthenticated ? {} : "skip");
  const callbackRef = useRef(onSession);
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => { callbackRef.current = onSession; }, [onSession]);
  useEffect(() => {
    let active = true;
    if (!isAuthenticated) {
      void callbackRef.current({ token: null, email: null, signOut: async () => { await signOut(); } });
      return () => { active = false; };
    }
    if (profile === undefined) return () => { active = false; };
    void fetchAccessToken({ forceRefreshToken: false }).then((token) => {
      if (active) void callbackRef.current({ token, email: profile?.email ?? null, signOut: async () => { await signOut(); } });
    }).catch((reason: unknown) => {
      if (active) setError(safeAuthMessage(reason));
    });
    return () => { active = false; };
  }, [isAuthenticated, profile, fetchAccessToken, signOut]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setWorking(true); setError("");
    const formData = new FormData(event.currentTarget);
    formData.set("flow", mode);
    try { await signIn("password", formData); }
    catch (reason) { setError(safeAuthMessage(reason)); }
    finally { setWorking(false); }
  }

  if (isLoading) return <p className="mitpad-auth-status">Preparando el acceso seguro…</p>;
  if (isAuthenticated) return <div className="mitpad-auth-session"><span>Sesión iniciada{profile?.email ? `: ${profile.email}` : ""}</span><button type="button" onClick={() => void signOut()}>Cerrar sesión</button></div>;
  return <div className="mitpad-auth-form-wrap">
    <form className="mitpad-auth-form" onSubmit={submit}>
      <label>Correo electrónico<input name="email" type="email" autoComplete="email" maxLength={254} required /></label>
      <label>Contraseña<input name="password" type="password" autoComplete={mode === "signIn" ? "current-password" : "new-password"} minLength={10} maxLength={128} required /></label>
      {error && <p className="mitpad-auth-error" role="alert">{error}</p>}
      <button className="mitpad-auth-submit" type="submit" disabled={working}>{working ? "Un momento…" : mode === "signIn" ? "Iniciar sesión" : "Crear cuenta"}</button>
    </form>
    <button className="mitpad-auth-switch" type="button" onClick={() => { setError(""); setMode(mode === "signIn" ? "signUp" : "signIn"); }}>
      {mode === "signIn" ? "¿Primera vez? Crear una cuenta" : "Ya tengo cuenta · Iniciar sesión"}
    </button>
    <p className="mitpad-auth-footnote">Contraseña de al menos 10 caracteres. Usa una única cuenta por workspace.</p>
  </div>;
}

function Bridge({ client, onSession }: { client: ConvexReactClient; onSession: AuthCallback }) {
  return <ConvexAuthProvider client={client}><PasswordForm onSession={onSession} /></ConvexAuthProvider>;
}

export function mountAuthBridge(element: HTMLElement, convexUrl: string, onSession: AuthCallback): () => void {
  const client = new ConvexReactClient(convexUrl);
  const root: Root = createRoot(element);
  root.render(<Bridge client={client} onSession={onSession} />);
  return () => { root.unmount(); void client.close(); };
}
