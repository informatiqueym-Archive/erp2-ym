import prisma from "../lib/prismaClient";

// Mappage des rôles et des modules autorisés
export const ROLES_PERMISSIONS: { [key: string]: string[] } = {
  super_admin: ["admin", "clients", "dossiers", "taches", "facturation", "stock", "comptabilite", "achats", "analytics", "rh"],
  pdg: ["admin", "clients", "dossiers", "taches", "facturation", "stock", "comptabilite", "achats", "analytics", "bons"],
  dg: ["admin", "clients", "dossiers", "taches", "facturation", "stock", "comptabilite", "achats", "analytics", "bons"],
  dga: ["admin", "clients", "dossiers", "taches", "facturation", "stock", "comptabilite", "achats", "analytics", "bons"],
  daf: ["clients", "dossiers", "taches", "facturation", "comptabilite", "analytics", "bons"],
  auditeur1: ["clients", "dossiers", "taches", "facturation", "comptabilite", "analytics", "bons"],
  auditeur2: ["clients", "dossiers", "taches", "analytics", "bons"],
  secretariat: ["dashboard", "dossiers", "clients", "taches"],
  validation: ["dashboard", "dossiers", "taches"],
  validation_role: ["dashboard", "dossiers", "taches"],
  guce: ["dashboard", "dossiers", "taches"],
  acconage: ["dashboard", "dossiers", "bons", "taches"],
  enlevement: ["dashboard", "dossiers", "bons", "taches"],
  facturation: ["dashboard", "documents", "facturation", "dossiers", "clients", "taches"],
  fiscalite: ["dashboard", "dossiers", "taches", "analytics"],
  cloture: ["dashboard", "dossiers", "taches"],
  agent_payeur: ["dashboard", "bons", "dossiers", "taches", "comptabilite"],
  caisse: ["dashboard", "bons", "dossiers", "taches", "comptabilite"],
  analyste: ["dashboard", "analytics", "dossiers", "taches"],
  comptable: ["clients", "facturation", "stock", "comptabilite", "achats", "analytics", "dossiers"],
  commercial: ["clients", "dossiers", "taches", "facturation", "analytics"],
  operationnel: ["clients", "dossiers", "taches"],
  magasinier: ["stock", "achats", "dossiers"],
  rh: ["rh"],
  lecture: ["clients", "dossiers", "taches", "facturation", "stock", "comptabilite", "achats", "analytics"],
  finances: ["dashboard", "documents", "facturation", "dossiers", "clients", "taches"],
  comptable_ops: ["dashboard", "documents", "facturation", "dossiers", "accounting", "comptabilite", "reports", "taches"]
};

// Middleware d'authentification obligatoire et de contrôle d'accès global (RBAC)
export const requireAuth = async (req: any, res: any, next: any) => {
  if (!req.session || !req.session.userId) {
    return res.redirect("/login");
  }

  try {
    // Récupérer l'utilisateur frais de la DB pour être sûr de son état
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId }
    });

    if (!user) {
      req.session.destroy(() => {
        res.redirect("/login");
      });
      return;
    }

    if (!user.actif) {
      req.session.error_msg = "Votre compte a été désactivé par l'administrateur.";
      req.session.destroy(() => {
        res.redirect("/login");
      });
      return;
    }

    // Garder la session synchrone
    req.session.user = user;
    res.locals.user = user;

    // Si changement de mot de passe forcé, rediriger vers le profil (sauf si on y est déjà ou qu'on se déconnecte)
    if (user.force_pwd_change && req.path !== "/profile" && req.path !== "/logout" && !req.path.startsWith("/api")) {
      req.session.warning_msg = "Changement de mot de passe requis par l'administrateur.";
      return res.redirect("/profile");
    }

    // Restriction globale pour le rôle "lecture" : interdire les requêtes de modification (POST, PATCH, DELETE, PUT)
    if (user.role === "lecture" && req.method !== "GET" && !req.path.startsWith("/logout") && !req.path.startsWith("/profile")) {
      return res.status(403).render("errors/403", {
        message: "Action interdite : vous disposez uniquement d'un accès en lecture seule."
      });
    }

    next();
  } catch (error) {
    console.error("[RBAC AUTH] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
};

// Middleware pour restreindre l'accès à un module donné
export const requireModule = (moduleName: string) => {
  return (req: any, res: any, next: any) => {
    const user = req.session.user;
    if (!user) {
      return res.redirect("/login");
    }

    const permittedModules = ROLES_PERMISSIONS[user.role] || [];
    if (user.role === "super_admin" || permittedModules.includes(moduleName)) {
      return next();
    }

    console.warn(`[RBAC] Accès refusé au module "${moduleName}" pour l'utilisateur ${user.email} (Rôle: ${user.role})`);
    res.status(403).render("errors/403", {
      message: `Vous n'avez pas l'autorisation d'accéder au module : ${moduleName.toUpperCase()}`
    });
  };
};

// Middleware spécifique pour le rôle super_admin
export const requireSuperAdmin = (req: any, res: any, next: any) => {
  const user = req.session.user;
  if (!user) {
    return res.redirect("/login");
  }

  if (user.role === "super_admin") {
    return next();
  }

  console.warn(`[RBAC] Accès super_admin refusé pour l'utilisateur ${user.email} (Rôle: ${user.role})`);
  res.status(403).render("errors/403", {
    message: "Cet espace est strictement réservé aux Super Administrateurs."
  });
};
