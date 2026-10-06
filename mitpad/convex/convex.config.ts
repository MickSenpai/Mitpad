import { defineApp } from "convex/server";
import { v } from "convex/values";

// Variables del despliegue: npx convex env set NOMBRE valor
export default defineApp({
  env: {
    MITPAD_TOKEN: v.optional(v.string()), // token de la app de escritorio (lo lee de MITPAD_TOKEN)
  },
});
