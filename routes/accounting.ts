import { Router } from "express";
import { ensureDefaultAccounts, getSoldeCompte } from "../lib/accounting";
import { requireAuth, requireModule } from "./rbac";
import prisma from "../lib/prismaClient";

const router = Router();

// Protéger toutes les routes de ce fichier avec la restriction de module comptabilite
router.use(requireAuth, requireModule("comptabilite"));

// GET /accounting/journal - Livre Journal paginé et filtrable
router.get("/accounting/journal", requireAuth, async (req: any, res: any) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const { journal, date_from, date_to, compte_id } = req.query;

    // S'assurer que le plan comptable existe pour l'affichage cohérent
    await ensureDefaultAccounts(prisma, userSociete);

    // Récupérer la liste des comptes pour le sélecteur de filtre
    const filterComptes = await prisma.compteComptable.findMany({
      where: { societe: userSociete },
      orderBy: { code: "asc" }
    });

    const whereClause: any = { societe: userSociete };

    if (journal) {
      whereClause.journal = String(journal);
    }
    if (compte_id) {
      whereClause.compte_id = parseInt(String(compte_id));
    }
    if (date_from || date_to) {
      whereClause.date = {};
      if (date_from) {
        whereClause.date.gte = new Date(String(date_from));
      }
      if (date_to) {
        const dTo = new Date(String(date_to));
        dTo.setHours(23, 59, 59, 999);
        whereClause.date.lte = dTo;
      }
    }

    // Récupérer dans l'ordre chronologique pour calculer le solde progressif
    const allEntries = await prisma.ecritureComptable.findMany({
      where: whereClause,
      include: { compte: true },
      orderBy: { date: "asc" }
    });

    let runningSum = 0;
    const entriesWithRunning = allEntries.map(e => {
      runningSum += (e.debit - e.credit);
      return { ...e, runningBalance: runningSum };
    });

    // Inverser pour l'affichage antéchronologique (le plus récent d'abord)
    entriesWithRunning.reverse();

    // Pagination (50 par page)
    const page = parseInt(req.query.page as string) || 1;
    const limit = 50;
    const totalCount = entriesWithRunning.length;
    const totalPages = Math.ceil(totalCount / limit);
    const offset = (page - 1) * limit;
    const paginatedEntries = entriesWithRunning.slice(offset, offset + limit);

    res.render("accounting/journal", {
      title: "Livre Journal",
      entries: paginatedEntries,
      comptes: filterComptes,
      filters: {
        journal: journal || "",
        compte_id: compte_id || "",
        date_from: date_from || "",
        date_to: date_to || ""
      },
      pagination: {
        page,
        totalPages,
        totalCount
      },
      userRole: user?.role
    });
  } catch (error) {
    console.error("Erreur livre journal:", error);
    res.status(500).send("Erreur de récupération du livre journal comptable.");
  }
});

// GET /accounting/grand-livre - Grand Livre grouped by account
router.get("/accounting/grand-livre", requireAuth, async (req: any, res: any) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    // Récupération des comptes avec leurs écritures
    const comptes = await prisma.compteComptable.findMany({
      where: { societe: userSociete },
      include: {
        ecritures: {
          orderBy: { date: "desc" }
        }
      },
      orderBy: { code: "asc" }
    });

    const grandLivreData = comptes.map(c => {
      const totalDebit = c.ecritures.reduce((sum, e) => sum + e.debit, 0);
      const totalCredit = c.ecritures.reduce((sum, e) => sum + e.credit, 0);
      const solde = totalDebit - totalCredit;
      return {
        ...c,
        totalDebit,
        totalCredit,
        solde
      };
    });

    const selectedCompteId = req.query.compteId ? parseInt(String(req.query.compteId)) : null;
    let selectedCompte = null;
    if (selectedCompteId) {
      selectedCompte = await prisma.compteComptable.findUnique({
        where: { id: selectedCompteId },
        include: {
          ecritures: {
            orderBy: { date: "desc" },
            include: { user: { select: { nom: true } } }
          }
        }
      });
    }

    res.render("accounting/grand-livre", {
      title: "Grand Livre Général",
      comptes: grandLivreData,
      selectedCompte,
      selectedCompteId
    });
  } catch (error) {
    console.error("Erreur grand livre:", error);
    res.status(500).send("Erreur de chargement du grand livre.");
  }
});

// GET /accounting/balance - Balance de vérification périodique
router.get("/accounting/balance", requireAuth, async (req: any, res: any) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const comptes = await prisma.compteComptable.findMany({
      where: { societe: userSociete },
      include: { ecritures: true },
      orderBy: { code: "asc" }
    });

    let sumTotalDebit = 0;
    let sumTotalCredit = 0;
    let sumSoldeDebiteur = 0;
    let sumSoldeCrediteur = 0;

    const balanceSheet = comptes.map(c => {
      const dbSum = c.ecritures.reduce((sum, e) => sum + e.debit, 0);
      const crSum = c.ecritures.reduce((sum, e) => sum + e.credit, 0);

      let soldeDeb = 0;
      let soldeCred = 0;

      if (dbSum >= crSum) {
        soldeDeb = dbSum - crSum;
      } else {
        soldeCred = crSum - dbSum;
      }

      sumTotalDebit += dbSum;
      sumTotalCredit += crSum;
      sumSoldeDebiteur += soldeDeb;
      sumSoldeCrediteur += soldeCred;

      return {
        code: c.code,
        nom: c.nom,
        totalDebit: dbSum,
        totalCredit: crSum,
        soldeDebiteur: soldeDeb,
        soldeCrediteur: soldeCred
      };
    });

    const isBalanced = Math.abs(sumTotalDebit - sumTotalCredit) < 0.02;

    res.render("accounting/balance", {
      title: "Balance des Comptes",
      rows: balanceSheet,
      totals: {
        totalDebit: sumTotalDebit,
        totalCredit: sumTotalCredit,
        soldeDebiteur: sumSoldeDebiteur,
        soldeCrediteur: sumSoldeCrediteur
      },
      isBalanced
    });
  } catch (error) {
    console.error("Erreur balance des comptes:", error);
    res.status(500).send("Erreur de chargement de la balance de vérification.");
  }
});

// GET /accounting/periodes - Périodes comptables & états de clôture
router.get("/accounting/periodes", requireAuth, async (req: any, res: any) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    const periodes = await prisma.periodeComptable.findMany({
      where: { societe: userSociete },
      orderBy: [
        { annee: "desc" },
        { mois: "desc" }
      ]
    });

    res.render("accounting/periodes", {
      title: "Clôtures de Périodes",
      periodes,
      userRole: user?.role
    });
  } catch (error) {
    console.error("Erreur périodes:", error);
    res.status(500).send("Erreur lors de la récupération des périodes.");
  }
});

// POST /accounting/periodes/new - Créer une nouvelle période comptable
router.post("/accounting/periodes/new", requireAuth, async (req: any, res: any) => {
  try {
    const { mois, annee } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const userSociete = user?.societe || "YM-TRANSIT Transit & Logistics Ltd";

    if (!mois || !annee) {
      req.session.error_msg = "Mois et année de saisie obligatoires.";
      return res.redirect("/accounting/periodes");
    }

    await prisma.periodeComptable.create({
      data: {
        mois: parseInt(mois),
        annee: parseInt(annee),
        locked: false,
        societe: userSociete
      }
    });

    req.session.success_msg = `Exercice / Période de ${mois}/${annee} initialisée avec succès !`;
    res.redirect("/accounting/periodes");
  } catch (error) {
    console.error(error);
    req.session.error_msg = "Erreur de création : la période existe déjà ou valeurs invalides.";
    res.redirect("/accounting/periodes");
  }
});

// POST /accounting/periodes/:id/toggle-lock - Verrouiller / Déverrouiller la période
router.post("/accounting/periodes/:id/toggle-lock", requireAuth, async (req: any, res: any) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    if (user?.role !== "ADMIN") {
      req.session.error_msg = "Réservé aux administrateurs de la direction.";
      return res.redirect("/accounting/periodes");
    }

    const id = parseInt(req.params.id);
    const period = await prisma.periodeComptable.findUnique({ where: { id } });
    if (!period) {
      req.session.error_msg = "Période introuvable.";
      return res.redirect("/accounting/periodes");
    }

    await prisma.periodeComptable.update({
      where: { id },
      data: { locked: !period.locked }
    });

    req.session.success_msg = `Le statut de la période ${period.mois}/${period.annee} a été mis à jour avec succès (${!period.locked ? "Clôturée 🔒" : "Réouverte 🔓"}).`;
    res.redirect("/accounting/periodes");
  } catch (error) {
    console.error(error);
    req.session.error_msg = "Erreur de mise à jour du statut de la période.";
    res.redirect("/accounting/periodes");
  }
});

// POST /accounting/setup - Initialisation du plan comptable (Seeding interactif)
router.post("/accounting/setup", requireAuth, async (req: any, res: any) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    if (user?.role !== "ADMIN") {
      req.session.error_msg = "Droit d'administration requis pour paramétrer le plan comptable.";
      return res.redirect("/dashboard");
    }

    const userSociete = user.societe || "YM-TRANSIT Transit & Logistics Ltd";
    await ensureDefaultAccounts(prisma, userSociete);

    req.session.success_msg = "Plan comptable standard OHADA (Cameroun) initialisé avec brio !";
    res.redirect("/accounting/journal");
  } catch (error) {
    console.error("Erreur d'initialisation comptable standard:", error);
    req.session.error_msg = "Erreur interne lors du déploiement du modèle comptable.";
    res.redirect("/accounting/journal");
  }
});

export default router;
