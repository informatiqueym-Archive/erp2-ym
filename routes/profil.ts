import { Router } from "express";
import bcryptjs from "bcryptjs";
import { requireAuth } from "./rbac";
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
    console.error("Erreur de journalisation dans profil.ts :", error);
  }
}

// GET /profile - Géré par requireAuth
router.get("/profile", requireAuth, async (req: any, res: any) => {
  res.render("profile", {
    path: "/profile",
    title: "Mon Profil",
    user: req.session.user,
    error_msg: req.session.error_msg || "",
    success_msg: req.session.success_msg || "",
    warning_msg: req.session.warning_msg || ""
  });
  // Nettoyer les messages flash
  req.session.error_msg = null;
  req.session.success_msg = null;
  req.session.warning_msg = null;
});

// POST /profile/update - Mise à jour des informations personnelles
router.post("/profile/update", requireAuth, async (req: any, res: any) => {
  try {
    const { nom, prenom, email } = req.body;
    const userId = req.session.userId;

    if (!nom || !email) {
      req.session.error_msg = "Le nom et l'adresse email sont requis.";
      return res.redirect("/profile");
    }

    // Vérifier l'unicité de l'email
    const existing = await prisma.user.findFirst({
      where: {
        email,
        NOT: { id: userId }
      }
    });

    if (existing) {
      req.session.error_msg = "Cette adresse email est déjà utilisée par un autre collaborateur.";
      return res.redirect("/profile");
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        nom,
        prenom: prenom || null,
        email
      }
    });

    // Synchroniser la session
    req.session.user = updated;
    await logActivity(userId, "UPDATE_PROFILE", "User", userId);

    req.session.success_msg = "Vos informations ont été mises à jour avec succès.";
    res.redirect("/profile");
  } catch (error) {
    console.error("[PROFILE UPDATE] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

// POST /profile/password - Changement de mot de passe
router.post("/profile/password", requireAuth, async (req: any, res: any) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    const userId = req.session.userId;

    if (!new_password || !confirm_password) {
      req.session.error_msg = "Le nouveau mot de passe et sa confirmation sont requis.";
      return res.redirect("/profile");
    }

    if (new_password !== confirm_password) {
      req.session.error_msg = "Le nouveau mot de passe et le mot de passe de confirmation ne correspondent pas.";
      return res.redirect("/profile");
    }

    // Récupérer l'utilisateur pour vérifier l'ancien mot de passe
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      req.session.error_msg = "Utilisateur introuvable.";
      return res.redirect("/profile");
    }

    // Si pas de force_pwd_change ou si l'utilisateur saisit son mot de passe actuel
    if (current_password) {
      const match = await bcryptjs.compare(current_password, user.password);
      if (!match) {
        req.session.error_msg = "Le mot de passe actuel est incorrect.";
        return res.redirect("/profile");
      }
    } else if (!user.force_pwd_change) {
      // Si ce n'est pas un changement imposé, l'ancien mot de passe est obligatoire
      req.session.error_msg = "Le mot de passe actuel est obligatoire.";
      return res.redirect("/profile");
    }

    // Hasher le nouveau mot de passe
    const hashedPassword = await bcryptjs.hash(new_password, 10);

    // Mettre à jour en DB et désactiver force_pwd_change
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        force_pwd_change: false
      }
    });

    // Synchroniser la session
    req.session.user = updated;
    await logActivity(userId, "CHANGE_PASSWORD", "User", userId);

    req.session.success_msg = "Votre mot de passe a été modifié avec succès. Vous bénéficiez désormais de l'accès complet.";
    res.redirect("/profile");
  } catch (error) {
    console.error("[PROFILE PASSWORD] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
});

export default router;
