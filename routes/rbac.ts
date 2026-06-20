import prisma from "../lib/prismaClient";

// Department structure
export const DEPARTMENTS: { [key: string]: { label: string; icon: string; color: string; roles: string[]; sub?: { label: string; icon: string; roles: string[] }[] } } = {
  transit: {
    label: "Transit",
    icon: "bi-truck",
    color: "#0F6E56",
    bg: "#E1F5EE",
    roles: ["secretariat", "guce", "validation_role", "acconage", "enlevement"],
    sub: [
      { label: "Secrétariat", icon: "bi-folder-plus", roles: ["secretariat"] },
      { label: "GUCE", icon: "bi-file-earmark-check", roles: ["guce"] },
      { label: "Validation", icon: "bi-patch-check", roles: ["validation_role"] },
      {
        label: "Gestion des Bours", icon: "bi-cash-stack", roles: ["acconage", "enlevement"],
        sub: [
          { label: "Acconage", icon: "bi-boxes", roles: ["acconage"] },
          { label: "Enlèvement & Livraison", icon: "bi-truck-front", roles: ["enlevement"] }
        ]
      }
    ]
  },
  finance: {
    label: "Finance",
    icon: "bi-cash-coin",
    color: "#854F0B",
    bg: "#FAEEDA",
    roles: ["finances", "fiscalite", "cloture"],
    sub: [
      { label: "Facturation", icon: "bi-receipt", roles: ["finances"] },
      { label: "Fiscalité", icon: "bi-percent", roles: ["fiscalite"] },
      { label: "Clôture", icon: "bi-lock", roles: ["cloture"] }
    ]
  },
  analyse: {
    label: "Analyse",
    icon: "bi-graph-up",
    color: "#534AB7",
    bg: "#EEEDFE",
    roles: ["analyste", "auditeur1", "auditeur2"],
    sub: [
      { label: "Analyses & Rapports", icon: "bi-bar-chart-line", roles: ["analyste", "auditeur1", "auditeur2"] }
    ]
  },
  comptabilite: {
    label: "Comptabilité",
    icon: "bi-journal-check",
    color: "#185FA5",
    bg: "#E6F1FB",
    roles: ["caisse", "auditeur1"],
    sub: [
      { label: "Caisse", icon: "bi-safe", roles: ["caisse"] },
      { label: "Auditeur", icon: "bi-search", roles: ["auditeur1"] }
    ]
  },
  administration: {
    label: "Administration",
    icon: "bi-building",
    color: "#993C1D",
    bg: "#FAECE7",
    roles: ["pdg", "dg", "dga", "daf", "auditeur1", "auditeur2", "super_admin"],
    sub: [
      { label: "PDG", icon: "bi-person-badge", roles: ["pdg"] },
      { label: "DG", icon: "bi-person-badge", roles: ["dg"] },
      { label: "DGA", icon: "bi-person-badge", roles: ["dga"] },
      { label: "DAF", icon: "bi-person-badge", roles: ["daf"] },
      { label: "Auditeur 1", icon: "bi-person-badge", roles: ["auditeur1"] },
      { label: "Auditeur 2", icon: "bi-person-badge", roles: ["auditeur2"] },
      { label: "Super Admin", icon: "bi-shield-lock", roles: ["super_admin"] }
    ]
  },
  archives: {
    label: "Archives",
    icon: "bi-archive",
    color: "#5F5E5A",
    bg: "#F1EFE8",
    roles: ["archiviste"],
    sub: [
      { label: "Archives", icon: "bi-archive-fill", roles: ["archiviste"] }
    ]
  }
};

export const ROLES_PERMISSIONS: { [key: string]: string[] } = {
  super_admin:    ["*"],
  // Administration
  pdg:            ["dashboard", "bons", "analytics", "dossiers", "admin"],
  dg:             ["dashboard", "bons", "analytics", "dossiers", "admin"],
  dga:            ["dashboard", "bons", "analytics", "dossiers"],
  daf:            ["dashboard", "bons", "analytics", "dossiers", "facturation"],
  auditeur1:      ["dashboard", "bons", "analytics", "dossiers", "facturation", "comptabilite", "reports"],
  auditeur2:      ["dashboard", "bons", "analytics", "dossiers"],
  // Transit
  secretariat:    ["dashboard", "dossiers", "clients", "taches"],
  guce:           ["dashboard", "dossiers", "taches"],
  validation_role:["dashboard", "dossiers", "taches"],
  acconage:       ["dashboard", "dossiers", "bons", "taches"],
  enlevement:     ["dashboard", "dossiers", "bons", "taches"],
  // Finance
  finances:       ["dashboard", "facturation", "dossiers", "clients"],
  fiscalite:      ["dashboard", "facturation", "analytics"],
  cloture:        ["dashboard", "dossiers"],
  // Comptabilité
  caisse:         ["dashboard", "bons", "dossiers", "facturation"],
  // Analyse
  analyste:       ["dashboard", "analytics", "reports"],
  archiviste:     ["dashboard", "dossiers"],
  // Legacy roles kept for compatibility
  comptable:      ["dashboard", "facturation", "comptabilite", "analytics", "dossiers"],
  commercial:     ["dashboard", "clients", "dossiers", "taches", "facturation"],
  operationnel:   ["dashboard", "clients", "dossiers", "taches"],
  magasinier:     ["dashboard", "stock"],
  direction:      ["dashboard", "bons", "analytics", "dossiers"],
  agent_payeur:   ["dashboard", "bons", "dossiers"],
  comptable_ops:  ["dashboard", "facturation", "comptabilite", "reports", "dossiers"],
  lecture:        ["dashboard", "dossiers"],
  finances_old:   ["dashboard", "facturation", "dossiers", "clients"]
};

// Role → department mapping for welcome page redirect
export const ROLE_DEPARTMENT: { [key: string]: string } = {
  pdg: "administration", dg: "administration", dga: "administration",
  daf: "administration", auditeur1: "administration", auditeur2: "administration",
  super_admin: "administration",
  secretariat: "transit", guce: "transit", validation_role: "transit",
  acconage: "transit", enlevement: "transit",
  finances: "finance", fiscalite: "finance", cloture: "finance",
  caisse: "comptabilite",
  analyste: "analyse",
  archiviste: "archives",
  // legacy
  comptable: "administration", direction: "administration",
  agent_payeur: "comptabilite", comptable_ops: "administration",
  operationnel: "transit", commercial: "finance", magasinier: "archives", lecture: "archives"
};

export const requireAuth = async (req: any, res: any, next: any) => {
  if (!req.session || !req.session.userId) {
    return res.redirect("/welcome");
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    if (!user) { req.session.destroy(() => res.redirect("/login")); return; }
    if (!user.actif) {
      req.session.error_msg = "Votre compte a été désactivé par l'administrateur.";
      req.session.destroy(() => res.redirect("/login"));
      return;
    }
    req.session.user = user;
    res.locals.user = user;
    if (user.force_pwd_change && req.path !== "/profile" && req.path !== "/logout" && !req.path.startsWith("/api")) {
      req.session.warning_msg = "Changement de mot de passe requis.";
      return res.redirect("/profile");
    }
    next();
  } catch (error) {
    console.error("[RBAC AUTH] Erreur :", error);
    res.status(500).render("errors/500", { error });
  }
};

export const requireModule = (moduleName: string) => {
  return (req: any, res: any, next: any) => {
    const user = req.session.user;
    if (!user) return res.redirect("/welcome");
    const perms = ROLES_PERMISSIONS[user.role] || [];
    if (user.role === "super_admin" || perms.includes("*") || perms.includes(moduleName)) return next();
    res.status(403).render("errors/403", { message: `Accès refusé au module : ${moduleName}` });
  };
};

export const requireSuperAdmin = (req: any, res: any, next: any) => {
  const user = req.session.user;
  if (!user) return res.redirect("/welcome");
  if (user.role === "super_admin") return next();
  res.status(403).render("errors/403", { message: "Réservé aux Super Administrateurs." });
};
