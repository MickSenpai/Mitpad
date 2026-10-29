import { convexAuth, getAuthUserId } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { mutation, query } from "./_generated/server";
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
    const image = user.profileImageStorageId
      ? await ctx.storage.getUrl(user.profileImageStorageId)
      : user.image ?? null;
    return { email: user.email ?? null, name: user.name ?? null, image };
  },
});

export const actualizarPerfil = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, { name }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Inicia sesión para editar tu perfil.");
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 80) throw new Error("El nombre debe tener entre 1 y 80 caracteres.");
    await ctx.db.patch(userId, { name: cleanName });
    return null;
  },
});

export const crearUrlSubidaFotoPerfil = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    if (!(await getAuthUserId(ctx))) throw new Error("Inicia sesión para cambiar tu foto.");
    return await ctx.storage.generateUploadUrl();
  },
});

export const guardarFotoPerfil = mutation({
  args: { storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, { storageId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Inicia sesión para cambiar tu foto.");
    const metadata = await ctx.db.system.get("_storage", storageId);
    if (!metadata || !["image/jpeg", "image/png", "image/webp"].includes(metadata.contentType ?? "") || metadata.size > 5 * 1024 * 1024) {
      throw new Error("Usa una imagen JPEG, PNG o WebP de hasta 5 MB.");
    }
    const user = await ctx.db.get(userId);
    const previous = user?.profileImageStorageId;
    const image = await ctx.storage.getUrl(storageId);
    if (!image) throw new Error("No se pudo guardar la foto.");
    await ctx.db.patch(userId, { image, profileImageStorageId: storageId });
    if (previous && previous !== storageId) await ctx.storage.delete(previous);
    return null;
  },
});
