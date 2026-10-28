import { convexAuth, getAuthUserId } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { query } from "./_generated/server";
import { v } from "convex/values";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      profile(params) {
        const email = typeof params.email === "string" ? params.email.trim().toLowerCase() : "";
        if (!email || email.length > 254) throw new Error("Ingresa un correo válido.");
        return { email };
      },
      validatePasswordRequirements(password) {
        if (password.length < 10) throw new Error("La contraseña debe tener al menos 10 caracteres.");
        if (password.length > 128) throw new Error("La contraseña no puede superar 128 caracteres.");
      },
    }),
  ],
  jwt: {
    async customClaims(ctx, { userId }) {
      const user = await ctx.db.get(userId);
      return user?.email ? { email: user.email, emailVerified: Boolean(user.emailVerificationTime) } : {};
    },
  },
});

export const currentUser = query({
  args: {},
  returns: v.union(v.object({ email: v.union(v.string(), v.null()), name: v.union(v.string(), v.null()), image: v.union(v.string(), v.null()) }), v.null()),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return { email: user.email ?? null, name: user.name ?? null, image: user.image ?? null };
  },
});
