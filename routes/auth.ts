import { Router } from "express";
import bcryptjs from "bcryptjs";
import prisma from "../lib/prismaClient";
import { ROLE_DEPARTMENT } from "./rbac";

const router = Router();

async function logActivity(userId: number, action: string, entity: string, entityId?: number | string) {
  try {
    await prisma.activityLog.create({
      data: { user_id: userId, action, entity, entity_id: entityId !== undefined ? String(entityId) : null }
    });
  } catch (e) { console.error("Log error:", e); }
}

// GET / → redirect to welcome
router.get("/", (req: any, res: any) => {
  if (req.session?.userId) return res.redirect("/dashboard");
  res.redirect("/welcome");
});

// GET /welcome — the new entry point
router.get("/welcome", (req: any, res: any) => {
  if (req.session?.userId) return res.redirect("/dashboard");
  const error = req.session.error_msg || "";
  req.session.error_msg = null;
  res.render("auth/welcome", { error_msg: error });
});

// GET /login → redirect to welcome
router.get("/login", (req: any, res: any) => {
  if (req.session?.userId) return res.redirect("/dashboard");
  res.redirect("/welcome");
});

// GET /demo-login
router.get("/demo-login", async (req: any, res: any) => {
  try {
    let user = await prisma.user.findFirst({ where: { email: "admin@ym-transit.cm" } });
    if (!user) user = await prisma.user.findFirst({ where: { role: "super_admin" } });
    if (!user) { req.session.error_msg = "Aucun compte admin trouvé."; return res.redirect("/welcome"); }
    req.session.userId = user.id;
    req.session.user = user;
    await logActivity(user.id, "CONNEXION_DEMO", "User", user.id);
    req.session.save(() => res.redirect("/dashboard"));
  } catch (e) { res.redirect("/welcome"); }
});

// POST /login
router.post("/login", async (req: any, res: any) => {
  try {
    const { nom, password, dept } = req.body;
    if (!nom || !password) {
      req.session.error_msg = "Veuillez remplir tous les champs.";
      return res.redirect("/welcome");
    }

    const normalizedNom = nom.trim().toLowerCase();
    const allUsers = await prisma.user.findMany();
    const user = allUsers.find(u => {
      const dbEmail = u.email.trim().toLowerCase();
      const dbNom = u.nom.trim().toLowerCase();
      return dbEmail === normalizedNom || dbNom === normalizedNom ||
        dbEmail.split("@")[0] === normalizedNom;
    });

    if (!user) {
      req.session.error_msg = "Identifiant ou mot de passe incorrect.";
      return res.redirect("/welcome");
    }
    if (!user.actif) {
      req.session.error_msg = "Compte désactivé — contactez l'administrateur.";
      return res.redirect("/welcome");
    }

    const match = await bcryptjs.compare(password, user.password);
    if (!match) {
      req.session.error_msg = "Identifiant ou mot de passe incorrect.";
      return res.redirect("/welcome");
    }

    const updatedUser = await prisma.user.update({ where: { id: user.id }, data: { last_login: new Date() } });
    req.session.userId = updatedUser.id;
    req.session.user = updatedUser;
    await logActivity(updatedUser.id, "CONNEXION", "User", updatedUser.id);
    req.session.save(() => res.redirect("/dashboard"));
  } catch (e: any) {
    console.error("[AUTH] Error:", e);
    req.session.error_msg = "Erreur lors de la connexion.";
    res.redirect("/welcome");
  }
});

// GET /logout
router.get("/logout", async (req: any, res: any) => {
  if (req.session?.userId) await logActivity(req.session.userId, "DECONNEXION", "User", req.session.userId);
  req.session.destroy(() => res.redirect("/welcome"));
});

export default router;
