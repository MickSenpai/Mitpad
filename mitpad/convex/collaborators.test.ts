/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

async function person(t: ReturnType<typeof convexTest>, label: string) {
  const { userId, workspaceId } = await t.run(async ({ db }) => {
    const userId = await db.insert("users", { email: `${label}@example.test` });
    const now = Date.now();
    const workspaceId = await db.insert("workspaces", { ownerId: userId, name: `Espacio ${label}`, createdAt: now, updatedAt: now });
    await db.insert("webAccounts", { tokenIdentifier: `${label}|session`, userId, workspaceId, createdAt: now });
    return { userId, workspaceId };
  });
  const as = t.withIdentity({ subject: `${userId}|session`, tokenIdentifier: `${label}|session`, issuer: "https://x.test", email: `${label}@example.test` });
  return { as, userId, workspaceId };
}

async function pair() {
  const t = convexTest(schema, modules);
  const owner = await person(t, "owner");
  const guest = await person(t, "guest");
  const stranger = await person(t, "stranger");
  return { t, owner, guest, stranger };
}

async function join(owner: Awaited<ReturnType<typeof person>>, guest: Awaited<ReturnType<typeof person>>) {
  const { code } = await owner.as.mutation(api.collaborators.crearInvitacion, {});
  return await guest.as.mutation(api.collaborators.aceptarInvitacion, { code });
}

const projectNames = async (who: Awaited<ReturnType<typeof person>>) => (await who.as.query(api.web.dashboard, {})).projects.map((p) => p.name);

describe("workspace collaborators", () => {
  it("lets an invited person see and edit the owner's projects and tasks", async () => {
    const { owner, guest } = await pair();
    const project = await owner.as.mutation(api.web.crearProyecto, { name: "Compartido" });
    expect(await projectNames(guest)).not.toContain("Compartido");

    const joined = await join(owner, guest);
    expect(joined).toMatchObject({ id: owner.workspaceId, role: "editor" });
    expect(await projectNames(guest)).toContain("Compartido");

    await guest.as.mutation(api.web.crearTarea, { projectId: project.id, title: "Hecha por el invitado" });
    const tasks = (await owner.as.query(api.web.dashboard, {})).tasks.map((task) => task.title);
    expect(tasks).toContain("Hecha por el invitado");
  });

  it("uses each invitation code once and rejects wrong or own-workspace codes", async () => {
    const { owner, guest, stranger } = await pair();
    const { code } = await owner.as.mutation(api.collaborators.crearInvitacion, {});
    await guest.as.mutation(api.collaborators.aceptarInvitacion, { code });
    await expect(stranger.as.mutation(api.collaborators.aceptarInvitacion, { code })).rejects.toThrow(/no es válido|ya se usó/);
    await expect(stranger.as.mutation(api.collaborators.aceptarInvitacion, { code: "pci_" + "0".repeat(32) })).rejects.toThrow(/no es válido|ya se usó/);
    const own = await owner.as.mutation(api.collaborators.crearInvitacion, {});
    await expect(owner.as.mutation(api.collaborators.aceptarInvitacion, { code: own.code })).rejects.toThrow(/ya es tuyo/);
  });

  it("rejects expired invitations", async () => {
    const { t, owner, stranger } = await pair();
    const { code } = await owner.as.mutation(api.collaborators.crearInvitacion, {});
    await t.run(async ({ db }) => { for (const invite of await db.query("workspaceInvites").collect()) await db.patch(invite._id, { expiresAt: Date.now() - 1 }); });
    await expect(stranger.as.mutation(api.collaborators.aceptarInvitacion, { code })).rejects.toThrow(/venció|no es válido/);
  });

  it("keeps owner-only actions away from editors", async () => {
    const { owner, guest } = await pair();
    await join(owner, guest);
    await expect(guest.as.mutation(api.collaborators.crearInvitacion, {})).rejects.toThrow(/propietario/);
    await expect(guest.as.query(api.privateVariables.getVault, {})).rejects.toThrow(/propietario/);
    await expect(guest.as.mutation(api.web.crearCredencialAgente, { name: "x", model: "x", modelProvider: "x", clientType: "x" })).rejects.toThrow(/propietario/);
    await expect(guest.as.mutation(api.collaborators.quitarColaborador, { userId: owner.userId })).rejects.toThrow(/propietario/);
  });

  it("revokes access as soon as the owner removes the collaborator", async () => {
    const { owner, guest } = await pair();
    await owner.as.mutation(api.web.crearProyecto, { name: "Privado después" });
    await join(owner, guest);
    expect(await projectNames(guest)).toContain("Privado después");
    expect(await owner.as.mutation(api.collaborators.quitarColaborador, { userId: guest.userId })).toBe(true);
    expect(await projectNames(guest)).not.toContain("Privado después");
  });

  it("lets a collaborator leave and switch back to their own workspace", async () => {
    const { owner, guest } = await pair();
    await owner.as.mutation(api.web.crearProyecto, { name: "Ajeno" });
    await join(owner, guest);
    await guest.as.mutation(api.collaborators.cambiarWorkspace, { workspaceId: guest.workspaceId });
    expect(await projectNames(guest)).not.toContain("Ajeno");
    await guest.as.mutation(api.collaborators.cambiarWorkspace, { workspaceId: owner.workspaceId });
    expect(await projectNames(guest)).toContain("Ajeno");
    expect(await guest.as.mutation(api.collaborators.salirDelWorkspace, {})).toBe(true);
    expect(await projectNames(guest)).not.toContain("Ajeno");
  });

  it("refuses to switch into a workspace without membership", async () => {
    const { owner, stranger } = await pair();
    await expect(stranger.as.mutation(api.collaborators.cambiarWorkspace, { workspaceId: owner.workspaceId })).rejects.toThrow(/No tienes acceso/);
  });

  it("lists members for everyone but invitations only for the owner", async () => {
    const { owner, guest } = await pair();
    await join(owner, guest);
    await owner.as.mutation(api.collaborators.crearInvitacion, {});
    const asOwner = await owner.as.query(api.collaborators.equipo, {});
    const asGuest = await guest.as.query(api.collaborators.equipo, {});
    expect(asOwner.members.map((m) => m.email)).toEqual(["guest@example.test"]);
    expect(asOwner.invites).toHaveLength(1);
    expect(asGuest.invites).toEqual([]);
    expect(asGuest.current.role).toBe("editor");
    expect(asGuest.workspaces.map((w) => w.role).sort()).toEqual(["editor", "owner"]);
  });
});
