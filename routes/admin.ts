import { Router } from "express";
import bcryptjs from "bcryptjs";
import { requireAuth, requireSuperAdmin } from "./rbac";
import prisma from "../lib/prismaClient";

const router = Router();

// Helper de log d'activité
async function logActivity(userId: number, action: string, entity: string, entityId?: number | string) {
  try {
    await prisma.activityLog.create({
      data: {
        user_id: userId,
        action,
        entity,
        entity_id: entityId !== undefined && entityId !== null ? String(entityId) : null,
      },
    });
  } catch (error) {
    console.error("Erreur de journalisation dans admin.ts :", error);
  }
}

// GET /admin/users - Liste des utilisateurs
router.get("/admin/users", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { created_at: "desc" }
    });
    res.render("admin/users/index", {
      users,
      path: "/admin/users",
      title: "Gestion des Utilisateurs",
      error_msg: req.session.error_msg || "",
      success_msg: req.session.success_msg || ""
    });
    // Nettoyer les messages flash
    req.session.error_msg = null;
    req.session.success_msg = null;
  } catch (error) {
    console.error("[ADMIN USERS] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

// GET /admin/users/create - Formulaire de création
router.get("/admin/users/create", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  res.render("admin/users/create", {
    path: "/admin/users",
    title: "Créer un Utilisateur"
  });
});

// POST /admin/users/create - Soumission de création
router.post("/admin/users/create", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const { nom, prenom, email, password, role, societe } = req.body;

    if (!nom || !email || !password || !role || !societe) {
      req.session.error_msg = "Veuillez remplir tous les champs obligatoires.";
      return res.redirect("/admin/users/create");
    }

    // Vérifier si l'email existe déjà
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      req.session.error_msg = "Cette adresse email est déjà associée à un compte.";
      return res.redirect("/admin/users/create");
    }

    // Hasher le mot de passe
    const hashedPassword = await bcryptjs.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        nom,
        prenom: prenom || null,
        email,
        password: hashedPassword,
        role,
        societe,
        actif: true,
        force_pwd_change: true, // Forcer le changement au premier login
        created_by: req.session.userId
      }
    });

    await logActivity(req.session.userId, "CREATE_USER", "User", newUser.id);
    req.session.success_msg = `L'utilisateur ${nom} a été créé avec succès. Le changement de mot de passe sera exigé à sa première connexion.`;
    res.redirect("/admin/users");
  } catch (error) {
    console.error("[ADMIN USER CREATE] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

// GET /admin/users/edit/:id - Formulaire de modification
router.get("/admin/users/edit/:id", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const userId = parseInt(req.params.id);
    const targetUser = await prisma.user.findUnique({ where: { id: userId } });

    if (!targetUser) {
      req.session.error_msg = "Utilisateur introuvable.";
      return res.redirect("/admin/users");
    }

    res.render("admin/users/edit", {
      targetUser,
      path: "/admin/users",
      title: "Modifier l'Utilisateur"
    });
  } catch (error) {
    console.error("[ADMIN USER EDIT GET] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

// POST /admin/users/edit/:id - Traitement de la modification
router.post("/admin/users/edit/:id", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const userId = parseInt(req.params.id);
    const { nom, prenom, email, role, societe, actif, force_pwd_change } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!existingUser) {
      req.session.error_msg = "Utilisateur introuvable.";
      return res.redirect("/admin/users");
    }

    // Vérifier l'unicité du mail
    if (email !== existingUser.email) {
      const emailDup = await prisma.user.findUnique({ where: { email } });
      if (emailDup) {
        req.session.error_msg = "Cet email est déjà pris par un autre utilisateur.";
        return res.redirect(`/admin/users/edit/${userId}`);
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        nom,
        prenom: prenom || null,
        email,
        role,
        societe,
        actif: actif === "true" || actif === true,
        force_pwd_change: force_pwd_change === "true" || force_pwd_change === true
      }
    });

    // Si on a modifié l'utilisateur actuellement connecté, on synchronise sa session
    if (req.session.userId === userId) {
      req.session.user = updated;
    }

    await logActivity(req.session.userId, "UPDATE_USER", "User", userId);
    req.session.success_msg = `Utilisateur ${nom} mis à jour avec succès.`;
    res.redirect("/admin/users");
  } catch (error) {
    console.error("[ADMIN USER EDIT POST] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

// POST /admin/users/toggle/:id - Activer/Désactiver l'utilisateur
router.post("/admin/users/toggle/:id", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const userId = parseInt(req.params.id);
    
    if (userId === req.session.userId) {
      req.session.error_msg = "Vous ne pouvez pas désactiver votre propre compte Super Administrateur.";
      return res.redirect("/admin/users");
    }

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) {
      req.session.error_msg = "Utilisateur introuvable.";
      return res.redirect("/admin/users");
    }

    const nextState = !targetUser.actif;
    await prisma.user.update({
      where: { id: userId },
      data: { actif: nextState }
    });

    await logActivity(req.session.userId, nextState ? "ENABLE_USER" : "DISABLE_USER", "User", userId);
    req.session.success_msg = `Compte de ${targetUser.nom} ${nextState ? "Activé" : "Désactivé"} avec succès.`;
    res.redirect("/admin/users");
  } catch (error) {
    console.error("[ADMIN USER TOGGLE] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

// POST /admin/users/reset-pwd/:id - Réinitialiser le mot de passe
router.post("/admin/users/reset-pwd/:id", requireAuth, requireSuperAdmin, async (req: any, res: any) => {
  try {
    const userId = parseInt(req.params.id);
    const { new_password } = req.body;

    if (!new_password || new_password.trim() === "") {
      req.session.error_msg = "Le nouveau mot de passe ne peut pas être vide.";
      return res.redirect("/admin/users");
    }

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) {
      req.session.error_msg = "Utilisateur introuvable.";
      return res.redirect("/admin/users");
    }

    const hashedPassword = await bcryptjs.hash(new_password, 10);
    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        force_pwd_change: true
      }
    });

    await logActivity(req.session.userId, "RESET_PASSWORD", "User", userId);
    req.session.success_msg = `Le mot de passe de ${targetUser.nom} a été réinitialisé. Le changement lui sera imposé.`;
    res.redirect("/admin/users");
  } catch (error) {
    console.error("[ADMIN USER RESET PWD] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

export default router;
