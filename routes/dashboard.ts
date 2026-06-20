import { Router } from "express";
import { requireAuth } from "./rbac";
import prisma from "../lib/prismaClient";

const router = Router();

router.get("/dashboard", requireAuth, async (req: any, res: any) => {
  try {
    const userId = req.session.userId;
    const userRole = req.session.user?.role || "";
    const user = req.session.user;
    
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);

    // Get notifications count if any
    const unreadNotificationsCount = await prisma.notification.count({
      where: { user_id: userId, lu: false }
    });

    // ----------------------------------------------------
    // SECTION A: Mon Espace de Travail (Role-based pending work)
    // ----------------------------------------------------
    let pendingWork: any = null;
    let extraData: any = {};

    switch (userRole) {
      case "secretariat": {
        const logs = await prisma.activityLog.findMany({
          where: {
            user_id: userId,
            action: "OUVERTURE_DOSSIER",
            entity: "Dossier"
          },
          select: { entity_id: true }
        });
        const createdDossierIds = logs
          .map(l => l.entity_id ? parseInt(l.entity_id) : null)
          .filter((id): id is number => id !== null && !isNaN(id));

        const dossiers = await prisma.dossier.findMany({
          where: {
            id: { in: createdDossierIds },
            pipeline_status: "CREE"
          },
          include: { client: true }
        });
        pendingWork = dossiers;

        const countThisMonth = await prisma.activityLog.count({
          where: {
            user_id: userId,
            action: "OUVERTURE_DOSSIER",
            entity: "Dossier",
            created_at: { gte: startOfMonth }
          }
        });
        extraData = { createdThisMonthCount: countThisMonth };
        break;
      }
      case "guce": {
        pendingWork = await prisma.dossier.findMany({
          where: { pipeline_status: "GUCE" },
          include: { client: true }
        });
        break;
      }
      case "validation":
      case "validation_role": {
        pendingWork = await prisma.dossier.findMany({
          where: { pipeline_status: "VALIDATION" },
          include: { client: true }
        });
        break;
      }
      case "acconage":
      case "enlevement": {
        const dossiersEnTraitement = await prisma.dossier.findMany({
          where: { pipeline_status: "EN_TRAITEMENT" },
          include: { client: true }
        });
        const myPendingBons = await prisma.bonProvisoir.findMany({
          where: { demandeur_id: userId, etat: "EN_ATTENTE" },
          include: { dossier: true }
        });
        const dossiersBonReel = await prisma.dossier.findMany({
          where: { pipeline_status: "BON_REEL" },
          include: { client: true }
        });

        pendingWork = {
          dossiersEnTraitement,
          myPendingBons,
          dossiersBonReel
        };
        break;
      }
      case "pdg":
      case "dg":
      case "dga":
      case "daf": {
        pendingWork = await prisma.bonProvisoir.findMany({
          where: { etat: "EN_ATTENTE" },
          include: { dossier: true, demandeur: true }
        });
        break;
      }
      case "caisse":
      case "agent_payeur": {
        const approvedBons = await prisma.bonProvisoir.findMany({
          where: { etat: "APPROUVE" },
          include: { dossier: true, demandeur: true, bon_reel: true }
        });
        pendingWork = approvedBons.filter(b => !b.bon_reel);
        break;
      }
      case "finances":
      case "facturation": {
        pendingWork = await prisma.dossier.findMany({
          where: { pipeline_status: "FACTURATION" },
          include: { client: true }
        });
        break;
      }
      case "cloture": {
        pendingWork = await prisma.dossier.findMany({
          where: { pipeline_status: "CLOTURE" },
          include: { client: true }
        });
        break;
      }
      case "archiviste": {
        pendingWork = await prisma.dossier.findMany({
          where: { pipeline_status: "ARCHIVE" },
          include: { client: true },
          orderBy: { archived_at: "desc" },
          take: 10
        });
        const archiveCount = await prisma.dossier.count({
          where: { pipeline_status: "ARCHIVE" }
        });
        extraData = { archiveCount };
        break;
      }
      case "analyste":
      case "auditeur1":
      case "auditeur2": {
        const dossiersThisMonth = await prisma.dossier.count({
          where: { created_at: { gte: startOfMonth } }
        });
        const invoicesAgg = await prisma.document.aggregate({
          where: {
            type: { in: ["FACTURE", "Facture"] },
            created_at: { gte: startOfMonth },
            etat: { not: "ANNULE" }
          },
          _sum: { total_ttc: true }
        });
        const pendingBonsCount = await prisma.bonProvisoir.count({
          where: { etat: "EN_ATTENTE" }
        });
        pendingWork = {
          dossiersThisMonth,
          totalInvoicedThisMonth: invoicesAgg._sum.total_ttc || 0,
          pendingBonsCount
        };
        break;
      }
      case "comptable":
      case "comptable_ops": {
        const unpaidInvoices = await prisma.document.findMany({
          where: {
            type: { in: ["FACTURE", "Facture"] },
            etat: { in: ["BROUILLON", "EMIS", "EN_ATTENTE", "En attente de paiement"] }
          },
          include: { payments: true }
        });
        let unpaidCount = 0;
        let unpaidTotal = 0;
        unpaidInvoices.forEach(inv => {
          const paid = inv.payments.reduce((sum, p) => sum + p.montant, 0);
          const remains = inv.total_ttc - paid;
          if (remains > 0) {
            unpaidCount++;
            unpaidTotal += remains;
          }
        });
        const recentEntries = await prisma.ecritureComptable.findMany({
          orderBy: { date: "desc" },
          take: 10,
          include: { compte: true }
        });
        pendingWork = {
          unpaidCount,
          unpaidTotal,
          recentEntries
        };
        break;
      }
      case "super_admin": {
        pendingWork = "SUPER_ADMIN";
        break;
      }
      default: {
        pendingWork = null;
        break;
      }
    }

    // ----------------------------------------------------
    // SECTION B: Vue d'Ensemble de l'Entreprise (Company overview)
    // ----------------------------------------------------
    const [
      creeCount,
      guceCount,
      validationCount,
      enTraitementCount,
      bonProvisoirCount,
      bonReelCount,
      facturationCount,
      clotureCount
    ] = await Promise.all([
      prisma.dossier.count({ where: { pipeline_status: "CREE" } }),
      prisma.dossier.count({ where: { pipeline_status: "GUCE" } }),
      prisma.dossier.count({ where: { pipeline_status: "VALIDATION" } }),
      prisma.dossier.count({ where: { pipeline_status: "EN_TRAITEMENT" } }),
      prisma.dossier.count({ where: { pipeline_status: "BON_PROVISOIR" } }),
      prisma.dossier.count({ where: { pipeline_status: "BON_REEL" } }),
      prisma.dossier.count({ where: { pipeline_status: "FACTURATION" } }),
      prisma.dossier.count({ where: { pipeline_status: "CLOTURE" } }),
    ]);

    const pipelineSummary = {
      CREE: creeCount,
      GUCE: guceCount,
      VALIDATION: validationCount,
      EN_TRAITEMENT: enTraitementCount,
      BON_PROVISOIR: bonProvisoirCount,
      BON_REEL: bonReelCount,
      FACTURATION: facturationCount,
      CLOTURE: clotureCount
    };

    const last5Dossiers = await prisma.dossier.findMany({
      orderBy: { created_at: "desc" },
      take: 5,
      include: { client: true }
    });

    const isAdminRole = ["pdg", "dg", "dga", "daf", "auditeur1", "auditeur2", "super_admin"].includes(userRole);
    let adminMetrics: any = null;

    if (isAdminRole) {
      const revenueAndBons = await Promise.all([
        prisma.document.aggregate({
          where: {
            type: { in: ["FACTURE", "Facture"] },
            etat: { not: "ANNULE" },
            created_at: { gte: startOfMonth, lte: endOfMonth }
          },
          _sum: { total_ttc: true }
        }),
        prisma.bonProvisoir.aggregate({
          where: { etat: "EN_ATTENTE" },
          _sum: { montant_demande: true }
        }),
        prisma.document.findMany({
          where: {
            type: { in: ["FACTURE", "Facture"] },
            etat: { notIn: ["PAYE", "ANNULE"] }
          },
          include: { payments: true }
        })
      ]);

      const monthlyRevenue = revenueAndBons[0]._sum.total_ttc || 0;
      const totalPendingBonsAmount = revenueAndBons[1]._sum.montant_demande || 0;

      const activeInvoices = revenueAndBons[2];
      let overdueCount = 0;
      activeInvoices.forEach(inv => {
        const sumPaid = inv.payments.reduce((sum, p) => sum + p.montant, 0);
        const remaining = inv.total_ttc - sumPaid;
        const echeanceDate = new Date(inv.created_at);
        echeanceDate.setDate(echeanceDate.getDate() + 30);
        if (remaining > 0 && echeanceDate < today) {
          overdueCount++;
        }
      });

      adminMetrics = {
        monthlyRevenue,
        totalPendingBonsAmount,
        overdueCount
      };
    }

    res.render("dashboard/index", {
      user,
      role: userRole,
      pendingWork,
      extraData,
      pipelineSummary,
      last5Dossiers,
      isAdminRole,
      adminMetrics,
      unreadNotificationsCount,
      title: "Tableau de Bord — YM-TRANSIT"
    });
  } catch (error: any) {
    console.error("Erreur de chargement du tableau de bord :", error);
    res.status(500).render("errors/500", { error });
  }
});

export default router;
