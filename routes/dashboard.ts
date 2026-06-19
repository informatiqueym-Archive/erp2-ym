import { Router } from "express";
import { requireAuth } from "./rbac";
import prisma from "../lib/prismaClient";

const router = Router();

// GET /dashboard
router.get("/dashboard", requireAuth, async (req: any, res: any) => {
  try {
    const userId = req.session.userId;
    const today = new Date();

    // Début et fin du mois courant
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);

    // Une seule transaction/Promise.all efficace pour charger toutes les statistiques et les listes
    const [
      revenueAggregate,
      unpaidInvoices,
      activeDossiersCount,
      userPendingTasksCount,
      allInvoicesForOverdue,
      blockedTasks,
      allStocks,
      last5Invoices,
      activeDossiersList
    ] = await Promise.all([
      // 1. Chiffre d'affaires HT du mois courant (Factures émises non annulées)
      prisma.document.aggregate({
        where: {
          type: { in: ["FACTURE", "Facture"] },
          created_at: {
            gte: startOfMonth,
            lte: endOfMonth
          },
          etat: { not: "ANNULE" }
        },
        _sum: {
          total_ht: true
        }
      }),

      // 2. Factures non réglées (état Brouillon, Émis, En attente de paiement, EN_ATTENTE)
      prisma.document.findMany({
        where: {
          type: { in: ["FACTURE", "Facture"] },
          etat: { in: ["EMIS", "BROUILLON", "En attente de paiement", "EN_ATTENTE"] }
        },
        include: {
          payments: true
        }
      }),

      // 3. Nombre de dossiers de transit actifs (non clôturés)
      prisma.dossier.count({
        where: {
          etat: { notIn: ["CLOTURE", "Clôturé"] }
        }
      }),

      // 4. Nombre de tâches de l'utilisateur connecté en cours de traitement
      prisma.tache.count({
        where: {
          intervenant_id: userId,
          etat: { in: ["EN_COURS", "En cours", "en cours"] }
        }
      }),

      // 5. Recherche de toutes les factures actives pour calcul des factures en retard
      prisma.document.findMany({
        where: {
          type: { in: ["FACTURE", "Facture"] },
          etat: { notIn: ["PAYE", "ANNULE"] }
        },
        include: {
          client: true,
          payments: true
        }
      }),

      // 6. Tâches bloquées (En cours et dépassées)
      prisma.tache.findMany({
        where: {
          etat: { in: ["EN_COURS", "En cours"] },
          deadline: {
            lt: today
          }
        },
        include: {
          dossier: true,
          intervenant: true
        }
      }),

      // 7. Tous les stocks pour filtrer en mémoire de façon robuste
      prisma.stock.findMany(),

      // 8. 5 dernières factures créées
      prisma.document.findMany({
        where: {
          type: { in: ["FACTURE", "Facture"] }
        },
        orderBy: {
          created_at: "desc"
        },
        take: 5,
        include: {
          client: true,
          payments: true
        }
      }),

      // 9. Tous os dossiers de transit actifs pour statistiques douanières
      prisma.dossier.findMany({
        where: {
          etat: { notIn: ["CLOTURE", "Clôturé"] }
        }
      })
    ]);

    // --- TRAITEMENT DES DONNÉES EN MÉMOIRE ---

    // Chiffre d'affaires
    const monthlyRevenue = revenueAggregate._sum.total_ht || 0;

    // Calculs statistiques douanières
    let totalDroitsDouane = 0;
    let totalValeurDouane = 0;
    let valideDossiersCount = 0;
    let attenteDossiersCount = 0;

    activeDossiersList.forEach((d) => {
      if (d.droits_douane) totalDroitsDouane += d.droits_douane;
      if (d.valeur_douane) totalValeurDouane += d.valeur_douane;
      if (d.validation) {
        valideDossiersCount++;
      } else {
        attenteDossiersCount++;
      }
    });

    // Factures non payées cumulées
    let unpaidInvoicesCount = 0;
    let unpaidInvoicesTotalSum = 0;

    unpaidInvoices.forEach((inv) => {
      const sumPaid = inv.payments.reduce((sum, p) => sum + p.montant, 0);
      const remaining = inv.total_ttc - sumPaid;
      if (remaining > 0) {
        unpaidInvoicesCount++;
        unpaidInvoicesTotalSum += remaining;
      }
    });

    // Alertes 1 : Factures en retard (Date d'échéance dépassée [30 jours par défaut] et reste à payer > 0)
    const overdueInvoices = allInvoicesForOverdue.map((inv) => {
      const sumPaid = inv.payments.reduce((sum, p) => sum + p.montant, 0);
      const remains = inv.total_ttc - sumPaid;

      // Calcul date d'échéance par défaut : Émission + 30 jours
      const dateEcheance = new Date(inv.created_at);
      dateEcheance.setDate(dateEcheance.getDate() + 30);

      return {
        ...inv,
        dateEcheance,
        resteAPayer: remains
      };
    }).filter((inv) => inv.dateEcheance < today && inv.resteAPayer > 0);

    // Alertes 3 : Matériels logistiques en seuil de stock critique
    const lowStockItems = allStocks.filter((s) => s.quantite <= s.stock_min);

    // Préparation de la vue avec les données calculées
    res.render("dashboard/index", {
      stats: {
        monthlyRevenue,
        unpaidCount: unpaidInvoicesCount,
        unpaidAmount: unpaidInvoicesTotalSum,
        activeDossiers: activeDossiersCount,
        userPendingTasks: userPendingTasksCount
      },
      customsStats: {
        totalDroitsDouane,
        totalValeurDouane,
        valideDossiersCount,
        attenteDossiersCount
      },
      alerts: {
        overdueInvoices,
        blockedTasks,
        lowStock: lowStockItems
      },
      lastInvoices: last5Invoices,
      title: "Tableau de Bord Général"
    });
  } catch (error) {
    console.error("Erreur de chargement du tableau de bord :", error);
    res.status(500).send("Erreur interne lors de la génération du tableau de bord complet.");
  }
});

export default router;
