import { Router } from "express";
import { requireAuth, requireModule } from "./rbac";
import prisma from "../lib/prismaClient";

const router = Router();

// Protéger toutes les routes de ce fichier avec la restriction de module analytics
router.use(requireAuth, requireModule("analytics"));

// GET /analytics
router.get("/analytics", requireAuth, async (req: any, res: any) => {
  try {
    const today = new Date();
    const currentYear = today.getFullYear();

    // Default dates (current year)
    const defaultFrom = `${currentYear}-01-01`;
    const defaultTo = `${currentYear}-12-31`;

    const fromDateStr = (req.query.from as string) || defaultFrom;
    const toDateStr = (req.query.to as string) || defaultTo;

    const fromDate = new Date(fromDateStr);
    fromDate.setHours(0, 0, 0, 0);

    const toDate = new Date(toDateStr);
    toDate.setHours(23, 59, 59, 999);

    // Calculate dates for last year comparison
    const fromDateLastYear = new Date(fromDate);
    fromDateLastYear.setFullYear(fromDateLastYear.getFullYear() - 1);

    const toDateLastYear = new Date(toDate);
    toDateLastYear.setFullYear(toDateLastYear.getFullYear() - 1);

    // Filter for current calendar month
    const startOfCurMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const endOfCurMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);

    // Executing metrics query using Promise.all
    const [
      invoicesThisYear,
      invoicesLastYear,
      clientInvoices,
      invoicesForStats,
      allUsers,
      overdueTotalInvoices,
      thisMonthInvoicesForCA
    ] = await Promise.all([
      // 1. revenueByMonth (this year)
      prisma.document.findMany({
        where: {
          type: { in: ["FACTURE", "Facture"] },
          etat: { not: "ANNULE" },
          created_at: {
            gte: fromDate,
            lte: toDate
          }
        },
        select: {
          created_at: true,
          total_ttc: true
        }
      }),

      // 2. revenueLastYear (same months last year)
      prisma.document.findMany({
        where: {
          type: { in: ["FACTURE", "Facture"] },
          etat: { not: "ANNULE" },
          created_at: {
            gte: fromDateLastYear,
            lte: toDateLastYear
          }
        },
        select: {
          created_at: true,
          total_ttc: true
        }
      }),

      // 3. topClients (top clients in range)
      prisma.document.findMany({
        where: {
          type: { in: ["FACTURE", "Facture"] },
          etat: { not: "ANNULE" },
          created_at: {
            gte: fromDate,
            lte: toDate
          }
        },
        include: {
          client: true
        }
      }),

      // 4. invoiceStats (all invoices in range categorized)
      prisma.document.findMany({
        where: {
          type: { in: ["FACTURE", "Facture"] },
          created_at: {
            gte: fromDate,
            lte: toDate
          }
        }
      }),

      // 5. agentPerformance (tasks completed this calendar month per user)
      prisma.user.findMany({
        where: { actif: true },
        include: {
          taches: {
            where: {
              created_at: {
                gte: startOfCurMonth,
                lte: endOfCurMonth
              }
            }
          }
        }
      }),

      // 6. overdueTotal (overdue invoices sum from real database data)
      prisma.document.findMany({
        where: {
          type: { in: ["FACTURE", "Facture"] },
          etat: "EMIS",
          created_at: {
            lt: new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000) // 30 days ago
          }
        },
        select: {
          total_ttc: true
        }
      }),

      // Helper for CA ce mois KPI
      prisma.document.findMany({
        where: {
          type: { in: ["FACTURE", "Facture"] },
          etat: { not: "ANNULE" },
          created_at: {
            gte: startOfCurMonth,
            lte: endOfCurMonth
          }
        },
        select: {
          total_ttc: true
        }
      })
    ]);

    // Format 1 & 2: revenue By Month (Jan - Dec arrays)
    const monthlyRevenueThisYear = Array(12).fill(0);
    const monthlyRevenueLastYear = Array(12).fill(0);

    invoicesThisYear.forEach(invoice => {
      const monthIdx = new Date(invoice.created_at).getMonth();
      monthlyRevenueThisYear[monthIdx] += invoice.total_ttc;
    });

    invoicesLastYear.forEach(invoice => {
      const monthIdx = new Date(invoice.created_at).getMonth();
      monthlyRevenueLastYear[monthIdx] += invoice.total_ttc;
    });

    // Format 3: Top Clients aggregated
    const clientMap = new Map<number, { client_nom: string; total_ttc: number; count: number }>();
    clientInvoices.forEach(inv => {
      if (!inv.client) return;
      const cid = inv.client.id;
      const current = clientMap.get(cid) || { client_nom: inv.client.nom, total_ttc: 0, count: 0 };
      current.total_ttc += inv.total_ttc;
      current.count += 1;
      clientMap.set(cid, current);
    });

    const topClients = Array.from(clientMap.values())
      .sort((a, b) => b.total_ttc - a.total_ttc)
      .slice(0, 5);

    // Format 4: Invoice Stats
    let payeeStats = 0;
    let enAttenteStats = 0;
    let enRetardStats = 0;
    let overdueStatsAmount = 0; // Cumulative amount for overdue KPI card

    invoicesForStats.forEach(inv => {
      if (inv.etat === "PAYE") {
        payeeStats++;
      } else if (inv.etat === "EMIS") {
        const dueDate = new Date(inv.created_at);
        dueDate.setDate(dueDate.getDate() + 30);

        if (dueDate < today) {
          enRetardStats++;
          overdueStatsAmount += inv.total_ttc;
        } else {
          enAttenteStats++;
        }
      }
    });

    const invoiceStats = {
      payee: payeeStats,
      en_attente: enAttenteStats,
      en_retard: enRetardStats
    };

    // Format 5: Agent Performance
    const agentPerformance = allUsers.map(u => {
      let done = 0;
      let in_progress = 0;

      u.taches.forEach(t => {
        const statusUpper = t.etat.toUpperCase();
        if (["FAIT", "TERMINE", "TERMINÉ", "VALIDÉ", "VALIDE"].includes(statusUpper)) {
          done++;
        } else {
          in_progress++;
        }
      });

      return {
        id: u.id,
        nom: u.nom,
        role: u.role,
        done,
        in_progress,
        total: done + in_progress
      };
    });

    // Format 6: Sum of all overdue invoices
    const overdueTotalSum = overdueTotalInvoices.reduce((sum, inv) => sum + inv.total_ttc, 0);

    // KPI 1: CA ce mois
    const caCeMois = thisMonthInvoicesForCA.reduce((sum, inv) => sum + inv.total_ttc, 0);

    // KPI 2: Taux de paiement (Payée / Active Invoices)
    const totalActiveInvoices = payeeStats + enAttenteStats + enRetardStats;
    const tauxPaiement = totalActiveInvoices > 0 ? Math.round((payeeStats / totalActiveInvoices) * 100) : 0;

    // KPI 3: Overdue Stats (count + total amount of overdue invoices within range)
    // We already have enRetardStats and overdueStatsAmount calculated from invoicesForStats.
    // However, if we want overall, we can use the overdueTotalSum as well. Let's show both or use range-specific values. 
    // We will use overdueStatsAmount (for range) or fall back to overdueTotalSum if it contains no overdue.
    const overdueCount = enRetardStats;
    const overdueAmount = overdueStatsAmount || overdueTotalSum; 

    // KPI 4: Meilleur Agent (highest task completion count this month)
    let meilleurAgent = { nom: "Aucun", count: 0 };
    agentPerformance.forEach(agent => {
      if (agent.done > meilleurAgent.count) {
        meilleurAgent = { nom: agent.nom, count: agent.done };
      }
    });

    // Formatting for view injection
    res.render("analytics/index", {
      title: "Tableau de Bord Analytique",
      filters: {
        from: fromDateStr,
        to: toDateStr
      },
      kpis: {
        caCeMois,
        tauxPaiement,
        overdueCount,
        overdueAmount,
        meilleurAgent
      },
      chartData: {
        monthlyRevenueThisYear,
        monthlyRevenueLastYear,
        topClients,
        invoiceStats,
        agentPerformance
      }
    });

  } catch (error) {
    console.error("Erreur génération analytics :", error);
    res.status(500).send("Erreur lors de la génération des analyses.");
  }
});

export default router;
