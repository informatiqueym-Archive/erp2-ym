import { Router } from "express";
import bcryptjs from "bcryptjs";
import prisma from "../lib/prismaClient";

const router = Router();

// Helper pour enregistrer dans le journal d'activité
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
    console.error("Erreur de journalisation d'activité dans auth route :", error);
  }
}

// GET /login
router.get("/login", (req: any, res: any) => {
  if (req.session && req.session.userId) {
    return res.redirect("/dashboard");
  }
  const error = res.locals.error_msg || req.session.error_msg || "";
  res.render("auth/login", { error_msg: error });
});

// GET /demo-login
router.get("/demo-login", async (req: any, res: any) => {
  try {
    let user = await prisma.user.findFirst({
      where: { email: "admin@ym-transit.cm" }
    });
    if (!user) {
      user = await prisma.user.findFirst({
        where: { role: "super_admin" }
      });
    }
    if (!user) {
      user = await prisma.user.findFirst();
    }
    
    // Auto-création de l'administrateur de démo à la volée s'il est absent
    if (!user) {
      console.log("[AUTH] Aucun utilisateur trouvé pour la démo. Création du compte administrateur à la volée...");
      const adminHash = await bcryptjs.hash("admin123", 10);
      user = await prisma.user.create({
        data: {
          nom: "Yannick Abega",
          email: "admin@ym-transit.cm",
          password: adminHash,
          role: "super_admin",
          societe: "YM-TRANSIT Transit & Logistics Ltd",
          actif: true,
        },
      });

      // Lancement du seed complet en arrière-plan pour peupler les données de démonstration de manière asynchrone
      try {
        const { exec } = await import("child_process");
        const path = await import("path");
        const seedPath = path.resolve("dist", "seed.cjs");
        console.log("[AUTH] Déclenchement de l'auto-seed complet en arrière-plan...");
        exec(`node "${seedPath}"`, (err, stdout, stderr) => {
          if (err) console.error("[AUTH] Échec du seed automatique en arrière-plan :", err);
          else console.log("[AUTH] Seed automatique de démo en arrière-plan terminé avec succès !");
        });
      } catch (seedErr: any) {
        console.error("[AUTH] Erreur lors du déclenchement du seed en arrière-plan :", seedErr.message);
      }
    }

    if (!user) {
      req.session.error_msg = "Aucun utilisateur disponible pour la démonstration.";
      return res.redirect("/login");
    }
    req.session.userId = user.id;
    req.session.user = user;
    req.session.success_msg = `Bienvenue sur votre espace d'administration de démonstration !`;
    await logActivity(user.id, "CONNEXION_DEMO", "User", user.id);
    req.session.save((err: any) => {
      res.redirect("/dashboard");
    });
  } catch (error: any) {
    console.error("[AUTH] Erreur dans le login de démonstration :");
    console.error(error);
    if (error && typeof error === "object") {
      console.error("Prisma Code:", error.code);
      console.error("Prisma Meta:", error.meta);
    }
    res.redirect("/login");
  }
});

// POST /login
router.post("/login", async (req: any, res: any) => {
  try {
    const { nom, password } = req.body;
    console.log(`[AUTH] Tentative de connexion pour le nom/identifiant: "${nom}"`);

    if (!nom || !password) {
      req.session.error_msg = "Veuillez remplir tous les champs.";
      return res.redirect("/login");
    }

    // Recherche de l'utilisateur de manière robuste et insensible à la casse
    const normalizedNom = nom.trim().toLowerCase();
    const allUsers = await prisma.user.findMany();
    const user = allUsers.find(u => {
      const dbEmail = u.email.trim().toLowerCase();
      const dbNom = u.nom.trim().toLowerCase();
      const dbPrenom = u.prenom ? u.prenom.trim().toLowerCase() : "";
      const fullNameSlash = `${dbPrenom} ${dbNom}`.trim();
      const fullNameSlashRev = `${dbNom} ${dbPrenom}`.trim();
      
      return (
        dbEmail === normalizedNom ||
        dbNom === normalizedNom ||
        fullNameSlash === normalizedNom ||
        fullNameSlashRev === normalizedNom ||
        (normalizedNom === "admin" && dbEmail === "admin@ym-transit.cm") ||
        (normalizedNom === "transit" && dbEmail === "transit@ym-transit.cm") ||
        (normalizedNom === "compta" && dbEmail === "compta@ym-transit.cm") ||
        (normalizedNom === "caisse" && dbEmail === "caisse@ym-transit.cm") ||
        (normalizedNom === "pdg" && u.role === "pdg") ||
        (normalizedNom === "dg" && u.role === "dg") ||
        (normalizedNom === "dga" && u.role === "dga") ||
        (normalizedNom === "daf" && u.role === "daf") ||
        (normalizedNom === "auditeur1" && u.role === "auditeur1") ||
        (normalizedNom === "auditeur2" && u.role === "auditeur2") ||
        (normalizedNom === "secretariat" && u.role === "secretariat") ||
        (normalizedNom === "secretaire" && u.role === "secretaire") ||
        (normalizedNom === "guce" && u.role === "guce") ||
        (normalizedNom === "validation" && u.role === "validation") ||
        (normalizedNom === "acconage" && u.role === "acconage") ||
        (normalizedNom === "enlevement" && u.role === "enlevement") ||
        (normalizedNom === "facturation" && u.role === "facturation") ||
        (normalizedNom === "fiscalite" && u.role === "fiscalite") ||
        (normalizedNom === "cloture" && u.role === "cloture") ||
        (normalizedNom === "analyste" && u.role === "analyste")
      );
    });

    if (!user) {
      console.warn(`[AUTH] Aucun utilisateur trouvé dans la base pour l'identifiant: "${nom}"`);
      req.session.error_msg = "Identifiant ou mot de passe incorrect.";
      return res.redirect("/login");
    }

    console.log(`[AUTH] Utilisateur identifié: ID ${user.id} - ${user.nom} (Role: ${user.role}, Actif: ${user.actif})`);

    if (!user.actif) {
      console.warn(`[AUTH] Le compte ${user.nom} est désactivé.`);
      req.session.error_msg = "Compte désactivé, contactez l'administrateur";
      return res.redirect("/login");
    }

    // Validation du mot de passe
    const match = await bcryptjs.compare(password, user.password);
    console.log(`[AUTH] Validation hash mot de passe pour ${user.nom}: ${match ? 'SUCCÈS' : 'ÉCHEC'}`);

    if (!match) {
      req.session.error_msg = "Identifiant ou mot de passe incorrect.";
      return res.redirect("/login");
    }

    // Mettre à jour last_login
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { last_login: new Date() }
    });

    // Succès de l'authentification
    req.session.userId = updatedUser.id;
    req.session.user = updatedUser;
    req.session.success_msg = `Bienvenue sur YM-TRANSIT ERP, ${updatedUser.nom} !`;
    
    await logActivity(updatedUser.id, "CONNEXION", "User", updatedUser.id);

    // Déterminer le workspace de redirection selon le département
    let redirectUrl = "/dashboard";
    const uRole = updatedUser.role;

    if (uRole === "secretariat" || uRole === "secretaire" || uRole === "guce" || uRole === "validation" || uRole === "validation_role" || uRole === "fiscalite" || uRole === "cloture") {
      redirectUrl = "/dossiers";
    } else if (uRole === "acconage" || uRole === "enlevement" || uRole === "agent_payeur" || uRole === "caisse") {
      redirectUrl = "/bons/provisoir/pending";
    } else if (uRole === "facturation") {
      redirectUrl = "/documents";
    } else if (uRole === "analyste") {
      redirectUrl = "/analytics";
    } else if (uRole === "lecture" || uRole === "archives") {
      redirectUrl = "/archives"; // standard archives landing
    }

    console.log(`[AUTH] Connexion réussie pour ${updatedUser.nom}. Enregistrement manuel de la session...`);
    req.session.save((err: any) => {
      if (err) {
        console.error("[AUTH] Erreur d'enregistrement de session :", err);
      } else {
        console.log(`[AUTH] Session enregistrée avec succès. Redirection vers ${redirectUrl} pour l'utilisateur ID ${updatedUser.id}`);
      }
      res.redirect(redirectUrl);
    });
  } catch (error: any) {
    console.error("[AUTH] Erreur d'authentification :");
    console.error(error);
    if (error && typeof error === "object") {
      console.error("Prisma Code:", error.code);
      console.error("Prisma Meta:", error.meta);
    }
    req.session.error_msg = "Une erreur est survenue lors de la connexion.";
    res.redirect("/login");
  }
});

// GET /logout
router.get("/logout", async (req: any, res: any) => {
  if (req.session && req.session.userId) {
    await logActivity(req.session.userId, "DECONNEXION", "User", req.session.userId);
  }
  req.session.destroy((err: any) => {
    if (err) {
      console.error("Erreur lors de la déconnexion :", err);
    }
    res.redirect("/login");
  });
});

export default router;
