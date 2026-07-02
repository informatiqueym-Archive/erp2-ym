import { Router } from "express";
import { ensureDefaultAccounts, postEcriture, postPaymentEcriture } from "../lib/accounting";
import { requireAuth, requireModule } from "./rbac";
import prisma from "../lib/prismaClient";
import { generateRef } from "../lib/generateRef";

const router = Router();

// Protéger toutes les routes de ce fichier avec la restriction de module facturation
router.use(requireAuth, requireModule("facturation"));

// GET /documents - Liste de toutes les pièces et factures
router.get("/documents", requireAuth, async (req: any, res: any) => {
  try {
    const list = await prisma.document.findMany({
      include: {
        client: true,
        payments: true
      },
      orderBy: {
        created_at: "desc"
      }
    });

    res.render("documents/index", {
      documents: list,
      title: "Gestion des Factures & Devis"
    });
  } catch (error) {
    console.error("Erreur listing documents :", error);
    res.status(550).send("Erreur lors de la récupération des factures.");
  }
});

// GET /documents/create - Formulaire de création dynamique d'une facture
router.get("/documents/create", requireAuth, async (req: any, res: any) => {
  try {
    const { dossier_id } = req.query;
    let preselectedDossier: any = null;

    if (dossier_id) {
      preselectedDossier = await prisma.dossier.findUnique({
        where: { id: parseInt(dossier_id) },
        include: {
          client: true,
          bons_provisoir: {
            where: { etat: "APPROUVE" },
            include: { bon_reel: true }
          }
        }
      });
    }

    const [clients, stocks] = await Promise.all([
      prisma.client.findMany({ orderBy: { nom: "asc" } }),
      prisma.stock.findMany({ orderBy: { nom: "asc" } })
    ]);

    res.render("documents/create", {
      clients,
      stocks,
      preselectedDossier,
      title: preselectedDossier ? `Facturation de Transit pour Dossier N° ${preselectedDossier.numero}` : "Nouvelle Facture de Transit"
    });
  } catch (error) {
    console.error("Erreur d'initialisation du formulaire :", error);
    res.status(500).send("Erreur d'initialisation du formulaire.");
  }
});

// POST /documents/create - Enregistrement de la facture en JSON (sans rechargement de page)
router.post("/documents/create", requireAuth, async (req: any, res: any) => {
  try {
    const {
      client_id,
      type,
      created_at,
      due_date,
      lines,
      remise,
      avance,
      total_ht,
      total_ttc
    } = req.body;

    if (!client_id || !type || !lines || lines.length === 0) {
      return res.status(400).json({ success: false, message: "Données de facture incomplètes." });
    }

    const clientIdParsed = parseInt(client_id);
    const remiseVal = parseFloat(remise) || 0;
    const avanceVal = parseFloat(avance) || 0;
    const totalHtVal = parseFloat(total_ht) || 0;
    const totalTtcVal = parseFloat(total_ttc) || 0;

    // Générer un numéro de facture unique
    const invoiceNumber = type === "DEVIS" ? generateRef("DEV") : type === "PROFORMA" ? generateRef("PRF") : generateRef("FAC");

    const parsedLines = lines.map((l: any) => ({
      description: l.description,
      quantite: parseInt(l.quantite) || 1,
      prix_unitaire: parseFloat(l.prix_unitaire) || 0,
      taxe_id: l.taxe_id || "TVA_0",
      total: (parseInt(l.quantite) || 1) * (parseFloat(l.prix_unitaire) || 0)
    }));

    // Exécuter l'ensemble des opérations sous transaction Prisma robuste
    const createdDoc = await prisma.$transaction(async (tx) => {
      // 1. Déduction des stocks d'articles
      for (const line of lines) {
        if (line.stock_id) {
          const stockId = parseInt(line.stock_id);
          const qteToDeduct = parseInt(line.quantite) || 1;
          const article = await tx.stock.findUnique({ where: { id: stockId } });
          if (article) {
            const newQty = Math.max(0, article.quantite - qteToDeduct);
            await tx.stock.update({
              where: { id: stockId },
              data: { quantite: newQty }
            });
          }
        }
      }

      // 2. Création du document
      const doc = await tx.document.create({
        data: {
          type,
          numero: invoiceNumber,
          client_id: clientIdParsed,
          societe: req.session.userSociete || "YM-TRANSIT Transit & Logistics Ltd",
          total_ht: totalHtVal,
          total_ttc: totalTtcVal,
          etat: avanceVal >= totalTtcVal ? "PAYE" : "EMIS",
          created_at: created_at ? new Date(created_at) : new Date()
        }
      });

      // Fetch client and user societe details to register accurate accounting journal records
      const clientObj = await tx.client.findUnique({ where: { id: clientIdParsed } });
      const clientNom = clientObj ? clientObj.nom : "Client";

      const currentUser = await tx.user.findUnique({ where: { id: req.session.userId } });
      const userSociete = currentUser?.societe || "YM-TRANSIT Transit & Logistics Ltd";

      await ensureDefaultAccounts(tx, userSociete);
      const comptes = await tx.compteComptable.findMany({ where: { societe: userSociete } });
      const c411 = comptes.find((c: any) => c.code === '411'); // Clients
      const c706 = comptes.find((c: any) => c.code === '706'); // Produits prestations
      const c445 = comptes.find((c: any) => c.code === '445'); // TVA collectée

      if (c411 && c706 && c445) {
        await postEcriture(tx, {
          journal: 'VTE',
          piece_ref: doc.numero,
          libelle: `Facture ${doc.numero} — ${clientNom}`,
          societe: userSociete,
          created_by: req.session.userId,
          date: doc.created_at,
          lignes: [
            { compte_id: c411.id, debit: doc.total_ttc, credit: 0 },
            { compte_id: c706.id, debit: 0, credit: doc.total_ht },
            { compte_id: c445.id, debit: 0, credit: doc.total_ttc - doc.total_ht }
          ]
        });
      }

      // 3. Création des lignes de facturation associées
      for (const line of parsedLines) {
        await tx.invoiceLine.create({
          data: {
            document_id: doc.id,
            description: line.description,
            quantite: line.quantite,
            prix_unitaire: line.prix_unitaire,
            taxe_id: line.taxe_id,
            total: line.total
          }
        });
      }

      // 4. Si une avance a été saisie, on l'ajoute automatiquement en paiement
      if (avanceVal > 0) {
        await tx.payment.create({
          data: {
            document_id: doc.id,
            montant: avanceVal,
            moyen: "ESPECES",
            date_paiement: new Date()
          }
        });

        await postPaymentEcriture(tx, {
          userId: req.session.userId,
          societe: userSociete,
          documentNumero: doc.numero,
          clientNom: clientNom,
          montant: avanceVal,
          date: new Date(),
          moyen: "ESPECES"
        });
      }

      // 5. Ajout d'une entrée dans le journal d'activité
      const allDossiers = await tx.dossier.findMany({ select: { numero: true } });
      const lineDescriptions = parsedLines.map((l: any) => l.description).join(" ");
      let matchedDossierNum: string | null = null;
      for (const d of allDossiers) {
        if (
          invoiceNumber.toUpperCase().includes(d.numero.toUpperCase()) ||
          lineDescriptions.toUpperCase().includes(d.numero.toUpperCase())
        ) {
          matchedDossierNum = d.numero;
          break;
        }
      }

      if (matchedDossierNum) {
        await tx.activityLog.create({
          data: {
            user_id: req.session.userId,
            action: 'document.created',
            entity: 'dossier',
            entity_id: String(matchedDossierNum),
            meta: JSON.stringify({
              numero: invoiceNumber,
              montant: totalTtcVal,
              type: type
            })
          }
        });
      }

      await tx.activityLog.create({
        data: {
          user_id: req.session.userId,
          action: `CREATION_${type}`,
          entity: "Document",
          entity_id: String(doc.id)
        }
      });

      return doc;
    });

    res.json({ success: true, id: createdDoc.id });
  } catch (error) {
    console.error("Erreur lors de la création de la facture dynamique :", error);
    res.status(500).json({ success: false, message: "Une erreur interne s'est produite lors de la persistance de l'opération." });
  }
});

// GET /documents/:id - Vue détaillée de la facture / devis
router.get("/documents/:id", requireAuth, async (req: any, res: any) => {
  try {
    const docId = parseInt(req.params.id);
    const document = await prisma.document.findUnique({
      where: { id: docId },
      include: {
        client: true,
        lines: true,
        payments: true
      }
    });

    if (!document) {
      req.session.error_msg = "Document comptable introuvable ou inexistant.";
      return res.redirect("/documents");
    }

    res.render("documents/detail", {
      document,
      title: `${document.type} - ${document.numero}`
    });
  } catch (error) {
    console.error("Erreur de récupération du détail de la facture :", error);
    res.status(500).send("Erreur de récupération du détail.");
  }
});

export default router;
