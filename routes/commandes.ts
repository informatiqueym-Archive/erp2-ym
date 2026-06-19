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
    console.error("Erreur de journalisation d'activité commandes:", error);
  }
}

// GET /commandes - Liste des bons de commande
router.get("/commandes", requireAuth, async (req: any, res: any) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const commandes = await prisma.bonCommande.findMany({
      where: { societe: userSociete },
      include: {
        fournisseur: true,
        lignes: true
      },
      orderBy: { date: "desc" }
    });

    res.render("commandes/index", {
      title: "Bons de Commande Fournisseurs",
      commandes,
      userRole: user?.role
    });
  } catch (error) {
    console.error("Erreur GET /commandes:", error);
    res.status(500).send("Erreur de récupération des bons de commande.");
  }
});

// GET /commandes/create - Formulaire de création de bon de commande
router.get("/commandes/create", requireAuth, async (req: any, res: any) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const fournisseurs = await prisma.fournisseur.findMany({
      where: { societe: userSociete, actif: true },
      orderBy: { nom: "asc" }
    });

    res.render("commandes/create", {
      title: "Créer un Bon de Commande",
      fournisseurs
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Erreur de chargement du formulaire.");
  }
});

// POST /commandes - Enregistrement du bon de commande (Auto-Numbering)
router.post("/commandes", requireAuth, async (req: any, res: any) => {
  try {
    const { fournisseur_id, date_livraison, notes, lignes } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const fId = parseInt(fournisseur_id);
    const supplier = await prisma.fournisseur.findFirst({
      where: { id: fId, societe: userSociete }
    });

    if (!supplier) {
      req.session.error_msg = "Fournisseur sélectionné invalide.";
      return res.redirect("/commandes/create");
    }

    // Extraction et traitement des lignes d'articles
    let parsedLignes: any[] = [];
    if (Array.isArray(lignes)) {
      parsedLignes = lignes;
    } else if (typeof lignes === "object" && lignes !== null) {
      // Si une seule ligne a été postée
      parsedLignes = [lignes];
    }

    if (parsedLignes.length === 0) {
      req.session.error_msg = "Veuillez insérer au moins une ligne d'article dans la commande.";
      return res.redirect("/commandes/create");
    }

    let total_ht = 0;
    const itemsData = parsedLignes.map((line: any) => {
      const q = parseFloat(line.quantite) || 0;
      const pu = parseFloat(line.prix_unitaire) || 0;
      const total = q * pu;
      total_ht += total;
      return {
        description: String(line.description || "Article"),
        quantite: q,
        prix_unitaire: pu,
        total: total
      };
    });

    // TVA simplifiée à 19.25% (norme Cameroun/OHADA) pour le calcul du total TTC
    const tvaRate = 0.1925;
    const total_ttc = total_ht * (1 + tvaRate);

    // Auto-génération du numéro BC-YYYY-XXXX sequential
    const currentYear = new Date().getFullYear();
    const countThisYear = await prisma.bonCommande.count({
      where: {
        societe: userSociete,
        date: {
          gte: new Date(`${currentYear}-01-01`),
          lte: new Date(`${currentYear}-12-31T23:59:59.999Z`)
        }
      }
    });

    const sequenceNum = String(countThisYear + 1).padStart(4, "0");
    const numeroBC = `BC-${currentYear}-${sequenceNum}`;

    // Transaction de création
    const newBc = await prisma.$transaction(async (tx) => {
      const bc = await tx.bonCommande.create({
        data: {
          numero: numeroBC,
          fournisseur_id: fId,
          date: new Date(),
          date_livraison: date_livraison ? new Date(date_livraison) : null,
          etat: "Brouillon",
          total_ht,
          total_ttc,
          notes: notes || null,
          societe: userSociete,
          created_by: req.session.userId,
        }
      });

      // Création des lignes de commande
      for (const item of itemsData) {
        await tx.ligneBonCommande.create({
          data: {
            commande_id: bc.id,
            description: item.description,
            quantite: item.quantite,
            prix_unitaire: item.prix_unitaire,
            total: item.total
          }
        });
      }

      return bc;
    });

    await logActivity(req.session.userId, `Création Bon de Commande ${numeroBC}`, "BonCommande", newBc.id);

    req.session.success_msg = `Bon de commande ${numeroBC} enregistré avec succès sous statut Brouillon !`;
    res.redirect("/commandes");
  } catch (error) {
    console.error("Erreur enregistrement BC:", error);
    req.session.error_msg = "Une erreur est survenue lors de l'enregistrement de la commande.";
    res.redirect("/commandes/create");
  }
});

// GET /commandes/:id - Fiche de détails d'un Bon de commande
router.get("/commandes/:id", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const commande = await prisma.bonCommande.findFirst({
      where: { id, societe: userSociete },
      include: {
        fournisseur: true,
        lignes: true,
        factures: true
      }
    });

    if (!commande) {
      req.session.error_msg = "Bon de commande introuvable.";
      return res.redirect("/commandes");
    }

    res.render("commandes/show", {
      title: `Commande ${commande.numero}`,
      commande,
      userRole: user?.role
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Erreur lors de la récupération des détails.");
  }
});

// POST / PATCH /commandes/:id/valider - Validation + Écriture Comptable d'achat
router.all("/commandes/:id/valider", requireAuth, async (req: any, res: any) => {
  // Supporte POST ou PATCH pour une meilleure intégration avec les formulaires EJS ordinaires
  if (req.method !== "POST" && req.method !== "PATCH") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const id = parseInt(req.params.id);
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const bc = await prisma.bonCommande.findFirst({
      where: { id, societe: userSociete },
      include: { fournisseur: true }
    });

    if (!bc) {
      req.session.error_msg = "Bon de commande introuvable ou accès non autorisé.";
      return res.redirect("/commandes");
    }

    if (bc.etat !== "Brouillon") {
      req.session.error_msg = `Ce bon de commande est déjà ${bc.etat}.`;
      return res.redirect(`/commandes/${id}`);
    }

    await prisma.$transaction(async (tx) => {
      // 1. Mettre à jour l'état du BC
      await tx.bonCommande.update({
        where: { id },
        data: { etat: "Validé" }
      });

      // 2. Créer automatiquement la Facture Fournisseur
      const invoiceNum = `FACT-SUP-${bc.numero.replace("BC-", "")}`;
      await tx.factureFournisseur.create({
        data: {
          numero: invoiceNum,
          commande_id: bc.id,
          fournisseur_id: bc.fournisseur_id,
          date: new Date(),
          echeance: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // échéance par défaut à 30 jours
          montant_ht: bc.total_ht,
          montant_ttc: bc.total_ttc,
          etat: "En attente",
          societe: userSociete
        }
      });

      // 3. Passer l'écriture comptable double entrée (débit 604 +, 4456 +, crédit 401 -)
      await ensureDefaultAccounts(tx, userSociete);
      const accounts = await tx.compteComptable.findMany({ where: { societe: userSociete } });

      const c604 = accounts.find(c => c.code === "604"); // Achats de matières / charges
      const c4456 = accounts.find(c => c.code === "4456"); // TVA Déductible
      const c401 = accounts.find(c => c.code === "401"); // Fournisseurs

      if (!c604 || !c4456 || !c401) {
        throw new Error("Comptes requis (604, 4456, 401) manquants dans le plan comptable.");
      }

      const tvaAmount = bc.total_ttc - bc.total_ht;

      const linesToPost = [
        { compte_id: c604.id, debit: bc.total_ht, credit: 0 },
        { compte_id: c401.id, debit: 0, credit: bc.total_ttc }
      ];

      // On n'ajoute la TVA déductible que si son montant est non nul
      if (tvaAmount > 0.05) {
        linesToPost.push({ compte_id: c4456.id, debit: tvaAmount, credit: 0 });
      }

      await postEcriture(tx, {
        journal: "ACH",
        piece_ref: bc.numero,
        libelle: `Facturation d'achat ${bc.numero} — ${bc.fournisseur.nom}`,
        societe: userSociete,
        created_by: req.session.userId,
        date: bc.date,
        lignes: linesToPost
      });
    });

    await logActivity(req.session.userId, `Validation & comptabilisation BC ${bc.numero}`, "BonCommande", id);

    req.session.success_msg = `Le bon de commande ${bc.numero} est validé ! Sa facture correspondante a été générée et les écritures comptables (Journals ACH / 604, 4456, 401) ont été passées dans le grand livre.`;
    res.redirect(`/commandes/${id}`);
  } catch (error: any) {
    console.error("Erreur validation commande:", error);
    req.session.error_msg = `Action avortée : ${error.message || "Erreur de comptabilisation"}`;
    res.redirect(`/commandes/${req.params.id}`);
  }
});

// POST / PATCH /commandes/:id/recevoir - Marquer la commande comme "Reçu"
router.all("/commandes/:id/recevoir", requireAuth, async (req: any, res: any) => {
  if (req.method !== "POST" && req.method !== "PATCH") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const id = parseInt(req.params.id);
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const bc = await prisma.bonCommande.findFirst({
      where: { id, societe: userSociete }
    });

    if (!bc) {
      req.session.error_msg = "Bon de commande introuvable.";
      return res.redirect("/commandes");
    }

    if (bc.etat !== "Validé") {
      req.session.error_msg = "Seule une commande à l'état 'Validé' peut être marquée comme reçue.";
      return res.redirect(`/commandes/${id}`);
    }

    await prisma.bonCommande.update({
      where: { id },
      data: { etat: "Reçu" }
    });

    await logActivity(req.session.userId, `Réception de la marchandise ${bc.numero}`, "BonCommande", id);

    req.session.success_msg = `Mise à jour : les marchandises et articles pour la commande ${bc.numero} ont été marqués comme REÇUS !`;
    res.redirect(`/commandes/${id}`);
  } catch (error) {
    console.error(error);
    req.session.error_msg = "Une erreur est survenue lors du changement de statut.";
    res.redirect(`/commandes/${req.params.id}`);
  }
});

// POST /commandes/:id/delete - Supprimer un bon de commande (Brouillon uniquement)
router.post("/commandes/:id/delete", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const bc = await prisma.bonCommande.findFirst({
      where: { id, societe: userSociete }
    });

    if (!bc) {
      req.session.error_msg = "Bon de commande introuvable.";
      return res.redirect("/commandes");
    }

    if (bc.etat !== "Brouillon") {
      req.session.error_msg = "Seuls les bons de commande sous statut Brouillon peuvent être supprimés.";
      return res.redirect(`/commandes/${id}`);
    }

    await prisma.bonCommande.delete({ where: { id } });
    await logActivity(req.session.userId, `Suppression Bon de Commande ${bc.numero}`, "BonCommande", id);

    req.session.success_msg = "Bon de commande supprimé de la base.";
    res.redirect("/commandes");
  } catch (error) {
    console.error(error);
    req.session.error_msg = "Une erreur est survenue lors de la suppression.";
    res.redirect("/commandes");
  }
});

export default router;
