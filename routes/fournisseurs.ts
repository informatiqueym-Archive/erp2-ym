import { Router } from "express";
import { requireAuth, requireModule } from "./rbac";
import prisma from "../lib/prismaClient";

const router = Router();

// Protéger toutes les routes de ce fichier avec la restriction de module achats
router.use(requireAuth, requireModule("achats"));

// HELPER: Log activity
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
    console.error("Erreur de journalisation d'activité fournisseurs:", error);
  }
}

// GET /fournisseurs - Liste des fournisseurs avec synthèse
router.get("/fournisseurs", requireAuth, async (req: any, res: any) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const fournisseurs = await prisma.fournisseur.findMany({
      where: { societe: userSociete },
      include: {
        factures: {
          include: {
            paiements: true
          }
        }
      },
      orderBy: { nom: "asc" }
    });

    // Calculer les totaux de chacun pour un affichage intelligent dans la liste
    const processedFournisseurs = fournisseurs.map(f => {
      const totalAchats = f.factures.reduce((acc, current) => acc + current.montant_ttc, 0);
      const totalPaye = f.factures.reduce((acc, current) => {
        return acc + current.paiements.reduce((payAcc, pay) => payAcc + pay.montant, 0);
      }, 0);
      const soldeDu = totalAchats - totalPaye;

      return {
        ...f,
        totalAchats,
        soldeDu
      };
    });

    res.render("fournisseurs/index", {
      title: "Gestion des Fournisseurs",
      fournisseurs: processedFournisseurs,
      userRole: user?.role
    });
  } catch (error) {
    console.error("Erreur GET /fournisseurs:", error);
    res.status(500).send("Erreur de récupération de la liste des fournisseurs.");
  }
});

// GET /fournisseurs/create - Formulaire d'ajout
router.get("/fournisseurs/create", requireAuth, async (req: any, res: any) => {
  res.render("fournisseurs/create", {
    title: "Ajouter un Fournisseur"
  });
});

// POST /fournisseurs/create - Enregistrement d'un fournisseur
router.post("/fournisseurs/create", requireAuth, async (req: any, res: any) => {
  try {
    const { nom, niu, rccm, adresse, tel, email, devise } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    if (!nom) {
      req.session.error_msg = "Le nom du fournisseur est obligatoire.";
      return res.redirect("/fournisseurs/create");
    }

    const fournisseur = await prisma.fournisseur.create({
      data: {
        nom,
        niu: niu || null,
        rccm: rccm || null,
        adresse: adresse || null,
        tel: tel || null,
        email: email || null,
        devise: devise || "FCFA",
        societe: userSociete,
        actif: true
      }
    });

    await logActivity(req.session.userId, "Création fournisseur " + nom, "Fournisseur", fournisseur.id);

    req.session.success_msg = `Fournisseur "${nom}" créé avec succès !`;
    res.redirect("/fournisseurs");
  } catch (error) {
    console.error("Erreur création fournisseur:", error);
    req.session.error_msg = "Échec lors de la création du fournisseur.";
    res.redirect("/fournisseurs/create");
  }
});

// GET /fournisseurs/edit/:id - Formulaire d'édition
router.get("/fournisseurs/edit/:id", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const fournisseur = await prisma.fournisseur.findFirst({
      where: { id, societe: userSociete }
    });

    if (!fournisseur) {
      req.session.error_msg = "Fournisseur introuvable ou accès non autorisé.";
      return res.redirect("/fournisseurs");
    }

    res.render("fournisseurs/edit", {
      title: "Modifier le Fournisseur",
      fournisseur
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Erreur lors de la récupération du fournisseur.");
  }
});

// POST /fournisseurs/edit/:id - Enregistrement des modifications
router.post("/fournisseurs/edit/:id", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const { nom, niu, rccm, adresse, tel, email, devise, actif } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const fournisseur = await prisma.fournisseur.findFirst({
      where: { id, societe: userSociete }
    });

    if (!fournisseur) {
      req.session.error_msg = "Fournisseur introuvable.";
      return res.redirect("/fournisseurs");
    }

    await prisma.fournisseur.update({
      where: { id },
      data: {
        nom,
        niu: niu || null,
        rccm: rccm || null,
        adresse: adresse || null,
        tel: tel || null,
        email: email || null,
        devise: devise || "FCFA",
        actif: actif === "true" || actif === true
      }
    });

    await logActivity(req.session.userId, "Modification fournisseur " + nom, "Fournisseur", id);

    req.session.success_msg = `Fournisseur "${nom}" mis à jour avec succès.`;
    res.redirect("/fournisseurs");
  } catch (error) {
    console.error("Erreur modification fournisseur:", error);
    req.session.error_msg = "Échec lors de la modification du fournisseur.";
    res.redirect(`/fournisseurs/edit/${req.params.id}`);
  }
});

// GET /fournisseurs/:id - Fiche détail du fournisseur (Total des achats et solde dû)
router.get("/fournisseurs/:id", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const fournisseur = await prisma.fournisseur.findFirst({
      where: { id, societe: userSociete },
      include: {
        commandes: {
          orderBy: { date: "desc" }
        },
        factures: {
          include: {
            paiements: true
          },
          orderBy: { date: "desc" }
        }
      }
    });

    if (!fournisseur) {
      req.session.error_msg = "Fournisseur introuvable.";
      return res.redirect("/fournisseurs");
    }

    // Calculs de synthèse
    const totalAchats = fournisseur.factures.reduce((acc, f) => acc + f.montant_ttc, 0);
    const totalPaye = fournisseur.factures.reduce((sumVal, f) => {
      const pSum = f.paiements.reduce((ps, p) => ps + p.montant, 0);
      return sumVal + pSum;
    }, 0);
    const soldeDu = totalAchats - totalPaye;

    res.render("fournisseurs/show", {
      title: `Fournisseur : ${fournisseur.nom}`,
      fournisseur,
      totalAchats,
      totalPaye,
      soldeDu,
      userRole: user?.role
    });
  } catch (error) {
    console.error("Erreur GET /fournisseurs/:id:", error);
    res.status(500).send("Erreur de récupération des informations du fournisseur.");
  }
});

// POST /fournisseurs/:id/delete - Suppression du fournisseur
router.post("/fournisseurs/:id/delete", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const fournisseur = await prisma.fournisseur.findFirst({
      where: { id, societe: userSociete }
    });

    if (!fournisseur) {
      req.session.error_msg = "Fournisseur introuvable.";
      return res.redirect("/fournisseurs");
    }

    // On supprime d'abord s'il n'y a pas de liaisons importantes, ou on le désactive au besoin
    try {
      await prisma.fournisseur.delete({ where: { id } });
      await logActivity(req.session.userId, "Suppression fournisseur " + fournisseur.nom, "Fournisseur", id);
      req.session.success_msg = `Fournisseur "${fournisseur.nom}" supprimé de la base.`;
    } catch (e) {
      // S'il existe des commandes/factures liées, on le désactive simplement
      await prisma.fournisseur.update({
        where: { id },
        data: { actif: false }
      });
      await logActivity(req.session.userId, "Désactivation fournisseur " + fournisseur.nom + " (commandes liées)", "Fournisseur", id);
      req.session.success_msg = `Le fournisseur "${fournisseur.nom}" possède des écritures ou commandes liées. Il a été désactivé pour préserver l'historique de l'ERP.`;
    }

    res.redirect("/fournisseurs");
  } catch (error) {
    console.error("Erreur suppression fournisseur:", error);
    req.session.error_msg = "Impossible de supprimer ce fournisseur.";
    res.redirect("/fournisseurs");
  }
});

export default router;
