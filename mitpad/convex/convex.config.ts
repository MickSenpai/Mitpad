import { defineApp } from "convex/server";
import { v } from "convex/values";

// Variables del despliegue: npx convex env set NOMBRE valor
export default defineApp({
  env: {
    MITPAD_TOKEN: v.optional(v.string()), // token de la app de escritorio (lo lee de MITPAD_TOKEN)
    MITPAD_USER_ID: v.optional(v.string()), // propietario del workspace personal (fallback UUID histórico)
    CLERK_FRONTEND_API_URL: v.optional(v.string()),
    MITPAD_WEB_ALLOWED_EMAIL: v.optional(v.string()),
  },
});
