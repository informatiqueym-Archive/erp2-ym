import { Router } from "express";
import { ensureDefaultAccounts, postEcriture } from "../lib/accounting";
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
    console.error("Erreur de journalisation d'activité factures fournisseur:", error);
  }
}

// GET /factures-fournisseur - Liste avec analyse de vieillissement
router.get("/factures-fournisseur", requireAuth, async (req: any, res: any) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const factures = await prisma.factureFournisseur.findMany({
      where: { societe: userSociete },
      include: {
        fournisseur: true,
        commande: true,
        paiements: true
      },
      orderBy: { date: "desc" }
    });

    const now = new Date();

    const processedFactures = factures.map(f => {
      const paidAmount = f.paiements.reduce((sum, p) => sum + p.montant, 0);
      const remainingAmount = f.montant_ttc - paidAmount;
      const isPaid = remainingAmount <= 0.05;

      let overdueDays = 0;
      let isOverdue = false;

      if (!isPaid && f.echeance) {
        const echDate = new Date(f.echeance);
        if (echDate < now) {
          isOverdue = true;
          const diffTime = Math.abs(now.getTime() - echDate.getTime());
          overdueDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        }
      }

      return {
        ...f,
        paidAmount,
        remainingAmount,
        isPaid,
        isOverdue,
        overdueDays
      };
    });

    res.render("factures-fournisseur/index", {
      title: "Factures Fournisseurs & Règlements",
      factures: processedFactures,
      userRole: user?.role
    });
  } catch (error) {
    console.error("Erreur GET /factures-fournisseur:", error);
    res.status(500).send("Erreur de récupération des factures fournisseurs.");
  }
});

// GET /factures-fournisseur/:id - Détail fiche facture fournisseur
router.get("/factures-fournisseur/:id", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const facture = await prisma.factureFournisseur.findFirst({
      where: { id, societe: userSociete },
      include: {
        fournisseur: true,
        commande: true,
        paiements: true
      }
    });

    if (!facture) {
      req.session.error_msg = "Facture introuvable ou accès non autorisé.";
      return res.redirect("/factures-fournisseur");
    }

    const totalPaye = facture.paiements.reduce((sum, p) => sum + p.montant, 0);
    const soldeRestant = facture.montant_ttc - totalPaye;

    res.render("factures-fournisseur/show", {
      title: `Facture Fournisseur : ${facture.numero}`,
      facture,
      totalPaye,
      soldeRestant,
      userRole: user?.role
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Erreur de chargement du détail de la facture.");
  }
});

// POST /factures-fournisseur/:id/paiement - Enregistrer un paiement & double entrée
router.post("/factures-fournisseur/:id/paiement", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const { montant, moyen, date_paiement } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const payAmt = parseFloat(montant);
    if (isNaN(payAmt) || payAmt <= 0) {
      req.session.error_msg = "Le montant du paiement doit être supérieur à 0.";
      return res.redirect(`/factures-fournisseur/${id}`);
    }

    const facture = await prisma.factureFournisseur.findFirst({
      where: { id, societe: userSociete },
      include: {
        fournisseur: true,
        paiements: true
      }
    });

    if (!facture) {
      req.session.error_msg = "Facture introuvable.";
      return res.redirect("/factures-fournisseur");
    }

    const payDate = date_paiement ? new Date(date_paiement) : new Date();

    const previousPayments = facture.paiements.reduce((sum, p) => sum + p.montant, 0);
    const remainingBefore = facture.montant_ttc - previousPayments;

    if (payAmt > remainingBefore + 1) {
      req.session.error_msg = `Le montant saisi (${payAmt.toLocaleString()} FCFA) excède le solde restant dû (${remainingBefore.toLocaleString()} FCFA).`;
      return res.redirect(`/factures-fournisseur/${id}`);
    }

    await prisma.$transaction(async (tx) => {
      // 1. Enregistrer le paiement fournisseur
      await tx.paiementFournisseur.create({
        data: {
          facture_id: id,
          montant: payAmt,
          moyen: moyen || "VIREMENT",
          date: payDate
        }
      });

      // 2. Mettre à jour l'état de la facture si soldée
      const isComplete = (previousPayments + payAmt) >= (facture.montant_ttc - 1);
      await tx.factureFournisseur.update({
        where: { id },
        data: {
          etat: isComplete ? "Payée" : "Partielle"
        }
      });

      // 3. Écritures comptables double entrée (débit 401 - Fournisseurs, crédit 512 / 571 - Banque / Caisse)
      await ensureDefaultAccounts(tx, userSociete);
      const accounts = await tx.compteComptable.findMany({ where: { societe: userSociete } });

      const c401 = accounts.find(c => c.code === "401"); // Fournisseurs
      
      const isCash = moyen === "ESPECES" || moyen === "CASH" || moyen === "CAISSE";
      const moneyCompte = isCash 
        ? (accounts.find(c => c.code === "571") || accounts.find(c => c.code === "512"))
        : (accounts.find(c => c.code === "512") || accounts.find(c => c.code === "571"));

      if (!c401 || !moneyCompte) {
        throw new Error("Comptes d'écriture requis manquants (401, 512 ou 571).");
      }

      await postEcriture(tx, {
        journal: isCash ? "CAI" : "BNQ",
        piece_ref: facture.numero,
        libelle: `Règlement d'achat ${facture.numero} — ${facture.fournisseur.nom}`,
        societe: userSociete,
        created_by: req.session.userId,
        date: payDate,
        lignes: [
          { compte_id: c401.id, debit: payAmt, credit: 0 },
          { compte_id: moneyCompte.id, debit: 0, credit: payAmt }
        ]
      });
    });

    await logActivity(req.session.userId, `Enregistrement règlement facture ${facture.numero} - ${payAmt} FCFA`, "FactureFournisseur", id);

    req.session.success_msg = `Règlement de ${payAmt.toLocaleString()} FCFA enregistré ! Le grand livre a été équilibré avec succès (Débit 401 Fournisseurs / Crédit ${moyen === "ESPECES" ? "571 Caisse" : "512 Banque"}).`;
    res.redirect(`/factures-fournisseur/${id}`);
  } catch (error: any) {
    console.error("Erreur règlement facture fournisseur:", error);
    req.session.error_msg = `Erreur survenue : ${error.message || "Échec d'enregistrement"}`;
    res.redirect(`/factures-fournisseur/${req.params.id}`);
  }
});

export default router;
