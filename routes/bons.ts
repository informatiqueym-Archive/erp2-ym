import { Router } from "express";
import { requireAuth } from "./rbac";
import { notify } from "../lib/notify";
import PDFDocument from "pdfkit";
import prisma from "../lib/prismaClient";

const router = Router();

// Helper de log d'activité
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
    console.error("Erreur de journalisation d'activité dans routing/bons :", error);
  }
}

// Helper pour créer automatiquement des tâches connectées au workflow
async function createAutoTask(dossierId: number, title: string, description: string, targetRole: string) {
  try {
    const targetUser = await prisma.user.findFirst({
      where: { role: targetRole, actif: true }
    });
    
    const duplicate = await prisma.tache.findFirst({
      where: { dossier_id: dossierId, titre: title, archive: false }
    });
    
    if (!duplicate) {
      await prisma.tache.create({
        data: {
          dossier_id: dossierId,
          titre: title,
          observations: description,
          intervenant_id: targetUser ? targetUser.id : null,
          etat: "EN_COURS",
          deadline: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) // 2 jours
        }
      });
      console.log(`[AUTO-TASK] Created task "${title}" assigned to role "${targetRole}"`);
    }
  } catch (err) {
    console.error("[AUTO-TASK] Failed to create automatic task:", err);
  }
}

// POST /bons/provisoir - Créer un Bon Provisoir
router.post("/bons/provisoir", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    if (!["acconage", "enlevement", "super_admin"].includes(user.role)) {
      req.session.error_msg = "Accès refusé : rôle non autorisé.";
      return res.redirect("/dashboard");
    }

    const { dossier_id, objet, montant_demande, items_json } = req.body;
    if (!dossier_id || !objet) {
      req.session.error_msg = "Veuillez remplir tous les champs obligatoires.";
      return res.redirect(dossier_id ? `/dossiers/${dossier_id}` : "/dossiers");
    }

    const dId = parseInt(dossier_id);
    const dossier = await prisma.dossier.findUnique({ where: { id: dId } });

    if (!dossier) {
      req.session.error_msg = "Dossier introuvable.";
      return res.redirect("/dossiers");
    }

    if (dossier.pipeline_status !== "EN_TRAITEMENT") {
      req.session.error_msg = "Le dossier doit être au statut 'En traitement' pour créer un bon provisoire.";
      return res.redirect(`/dossiers/${dId}`);
    }

    // Auto-generate numero
    const currentYear = new Date().getFullYear();
    const count = await prisma.bonProvisoir.count();
    let numero = `BP-${currentYear}-${String(count + 1).padStart(4, "0")}`;
    
    // Check for unique number
    let exists = await prisma.bonProvisoir.findUnique({ where: { numero } });
    let inc = 1;
    while (exists) {
      numero = `BP-${currentYear}-${String(count + 1 + inc).padStart(4, "0")}`;
      exists = await prisma.bonProvisoir.findUnique({ where: { numero } });
      inc++;
    }

    // Calcul automatique à partir de la liste des charges
    let finalItemsJson = "[]";
    let computedTotal = 0;

    if (items_json && items_json.trim() !== "" && items_json !== "[]") {
      try {
        finalItemsJson = items_json;
        const parsed = JSON.parse(items_json);
        if (Array.isArray(parsed)) {
          computedTotal = parsed.reduce((sum: number, it: any) => sum + parseFloat(it.montant || 0), 0);
        }
      } catch (e) {
        console.error("Erreur de parsing items_json :", e);
        computedTotal = parseFloat(montant_demande) || 0;
        finalItemsJson = JSON.stringify([{ designation: objet, montant: computedTotal }]);
      }
    } else {
      computedTotal = parseFloat(montant_demande) || 0;
      finalItemsJson = JSON.stringify([{ designation: objet, montant: computedTotal }]);
    }

    const bon = await prisma.bonProvisoir.create({
      data: {
        numero,
        dossier_id: dId,
        service: user.role,
        demandeur_id: req.session.userId,
        objet,
        montant_demande: computedTotal,
        items_json: finalItemsJson,
        etat: "EN_ATTENTE"
      }
    });

    // Update dossier pipeline status to BON_PROVISOIR
    await prisma.dossier.update({
      where: { id: dId },
      data: { pipeline_status: "BON_PROVISOIR" }
    });

    await logActivity(req.session.userId, "BON_PROVISOIR_CREE", "BonProvisoir", bon.id);
    await notify("direction", "Nouveau Bon Provisoir créé", `Le bon provisoire ${numero} a été créé par ${user.nom} pour le dossier ${dossier.numero}.`);

    // Gérer la tâche pour que la Direction puisse approuver/viser le bon
    await createAutoTask(dId, `✍️ Visa requis - Bon Provisoire ${numero}`, `Le bon provisoire ${numero} (${computedTotal.toLocaleString('fr-FR')} F) pour '${objet}' requiert vos visas de conformité directionnelle avant décaissement.`, "direction");

    req.session.success_msg = `Bon Provisoire ${numero} émis avec succès (Total : ${computedTotal.toLocaleString('fr-FR')} F).`;
    res.redirect(`/dossiers/${dId}`);
  } catch (error) {
    console.error("Erreur création bon provisoire :", error);
    res.status(500).render("errors/500", { error });
  }
});

// GET /bons/provisoir/pending - Liste des Bons Provisoires en attente
router.get("/bons/provisoir/pending", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    if (!["direction", "super_admin", "agent_payeur"].includes(user.role)) {
      req.session.error_msg = "Accès refusé.";
      return res.redirect("/dashboard");
    }

    const whereClause: any = { etat: "EN_ATTENTE" };
    
    // Si l'utilisateur est l'agent payeur (La Caisse), il ne voit le bon que s'il a reçu TOUS les 5 visas du Top Management
    if (user.role === "agent_payeur") {
      whereClause.tick_pdg = true;
      whereClause.tick_dg = true;
      whereClause.tick_dga = true;
      whereClause.tick_daf = true;
      whereClause.tick_audit = true;
    }

    const list = await prisma.bonProvisoir.findMany({
      where: whereClause,
      include: {
        dossier: { select: { numero: true, id: true } },
        demandeur: { select: { nom: true, prenom: true, role: true } }
      },
      orderBy: { created_at: "desc" }
    });

    res.render("bons/pending", {
      bons: list,
      path: "/bons/provisoir/pending",
      title: "Bons Provisoires en attente",
      error_msg: req.session.error_msg || "",
      success_msg: req.session.success_msg || ""
    });
    // Nettoyer messages
    req.session.error_msg = null;
    req.session.success_msg = null;
  } catch (error) {
    console.error("Erreur liste bons provisoires :", error);
    res.status(500).render("errors/500", { error });
  }
});

// PATCH /bons/provisoir/:id/approuver - Approuver un Bon Provisoir
router.patch("/bons/provisoir/:id/approuver", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    if (!["direction", "super_admin", "agent_payeur"].includes(user.role)) {
      return res.status(403).json({ ok: false, message: "Accès non autorisé." });
    }

    const bonId = parseInt(req.params.id);
    const bon = await prisma.bonProvisoir.findUnique({
      where: { id: bonId },
      include: { demandeur: true }
    });

    if (!bon) {
      return res.status(404).json({ ok: false, message: "Bon provisoire introuvable." });
    }

    // Si l'utilisateur est l'agent payeur (La Caisse), s'assurer que les 5 visas sont au complet
    if (user.role === "agent_payeur") {
      const allTicksApproved = bon.tick_pdg && bon.tick_dg && bon.tick_dga && bon.tick_daf && bon.tick_audit;
      if (!allTicksApproved) {
        return res.status(403).json({ ok: false, message: "Décaissement non autorisé : Les 5 signatures de visa du Top Management ne sont pas complètes." });
      }
    }

    await prisma.bonProvisoir.update({
      where: { id: bonId },
      data: {
        etat: "APPROUVE",
        approved_by_id: req.session.userId,
        approved_at: new Date()
      }
    });

    // Update Dossier Status to BON_REEL (as the next active step in pipeline)
    await prisma.dossier.update({
      where: { id: bon.dossier_id },
      data: { pipeline_status: "BON_REEL" }
    });

    try {
      // Mark cashier payment task as completed
      await prisma.tache.updateMany({
        where: { dossier_id: bon.dossier_id, titre: `💵 Décaissement - Bon Provisoire ${bon.numero}`, archive: false },
        data: { etat: "FAIT" }
      });
      
      // Create operational task for acconage/enlevement to submit justifying Bon Réel
      const operationalRole = bon.service || "acconage";
      await createAutoTask(
        bon.dossier_id,
        `🧾 Régularisation - Bon Provisoire ${bon.numero}`,
        `Le bon provisoire ${bon.numero} a été décaissé par la Caisse. Veuillez rassembler vos reçus de dépenses réelles sur le terrain et soumettre le Bon Réel pour finaliser la justification comptable du dossier.`,
        operationalRole
      );
    } catch (tError) {
      console.error("Erreur mise à jour tâches lors du décaissement/approbation :", tError);
    }

    await logActivity(req.session.userId, "BON_PROVISOIR_APPROUVE", "BonProvisoir", bonId);

    // Notifications
    await notify(bon.demandeur.role, "Bon Provisoire Approuvé", `Votre bon provisoire ${bon.numero} a été approuvé.`);
    await notify("agent_payeur", "Bon Provisoire prêt pour décaissement", `Le bon provisoire ${bon.numero} a été approuvé. Veuillez procéder au paiement.`);

    res.json({ ok: true, message: "Bon Provisoir approuvé" });
  } catch (error) {
    console.error("Erreur approbation bon provisoire :", error);
    res.status(500).json({ ok: false, message: "Erreur serveur." });
  }
});

// PATCH /bons/provisoir/:id/rejeter - Rejeter un Bon Provisoir
router.patch("/bons/provisoir/:id/rejeter", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    if (!["direction", "super_admin"].includes(user.role)) {
      return res.status(403).json({ ok: false, message: "Accès non autorisé." });
    }

    const bonId = parseInt(req.params.id);
    const { motif_rejet } = req.body;

    if (!motif_rejet || motif_rejet.trim() === "") {
      return res.status(400).json({ ok: false, message: "Le motif du rejet est obligatoire." });
    }

    const bon = await prisma.bonProvisoir.findUnique({
      where: { id: bonId },
      include: { demandeur: true }
    });

    if (!bon) {
      return res.status(404).json({ ok: false, message: "Bon provisoire introuvable." });
    }

    await prisma.bonProvisoir.update({
      where: { id: bonId },
      data: {
        etat: "REJETE",
        motif_rejet
      }
    });

    // Reset status to EN_TRAITEMENT
    await prisma.dossier.update({
      where: { id: bon.dossier_id },
      data: { pipeline_status: "EN_TRAITEMENT" }
    });

    await logActivity(req.session.userId, "BON_PROVISOIR_REJETE", "BonProvisoir", bonId);
    await notify(bon.demandeur.role, "Bon Provisoire Rejeté", `Votre bon provisoire ${bon.numero} a été rejeté. Motif : ${motif_rejet}`);

    res.json({ ok: true, message: "Bon Provisoir rejeté" });
  } catch (error) {
    console.error("Erreur rejet bon provisoire :", error);
    res.status(500).json({ ok: false, message: "Erreur serveur." });
  }
});

// POST /bons/reel - Soumettre un Bon Réel (Justification après dépenses)
router.post("/bons/reel", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    if (!["acconage", "enlevement", "super_admin"].includes(user.role)) {
      req.session.error_msg = "Accès refusé : rôle non autorisé.";
      return res.redirect("/dashboard");
    }

    const { bon_provisoir_id, montant_reel, observations, items_json } = req.body;
    if (!bon_provisoir_id) {
      req.session.error_msg = "Veuillez préciser le bon de référence.";
      return res.redirect("/dossiers");
    }

    const bpId = parseInt(bon_provisoir_id);
    const bonProvisoir = await prisma.bonProvisoir.findUnique({
      where: { id: bpId }
    });

    if (!bonProvisoir || bonProvisoir.etat !== "APPROUVE") {
      req.session.error_msg = "Le bon provisoire correspondant doit être approuvé.";
      return res.redirect("/dossiers");
    }

    const montant_provisoir = bonProvisoir.montant_demande;

    // Calcul automatique à partir de la liste des dépenses effectives
    let finalItemsJson = "[]";
    let computedTotalReel = 0;

    if (items_json && items_json.trim() !== "" && items_json !== "[]") {
      try {
        finalItemsJson = items_json;
        const parsed = JSON.parse(items_json);
        if (Array.isArray(parsed)) {
          computedTotalReel = parsed.reduce((sum: number, it: any) => sum + parseFloat(it.montant || 0), 0);
        }
      } catch (e) {
        console.error("Erreur de parsing items_json :", e);
        computedTotalReel = parseFloat(montant_reel) || 0;
        finalItemsJson = JSON.stringify([{ designation: "Dépenses réelles", montant: computedTotalReel }]);
      }
    } else {
      computedTotalReel = parseFloat(montant_reel) || 0;
      finalItemsJson = JSON.stringify([{ designation: "Dépenses réelles", montant: computedTotalReel }]);
    }

    const ecart = montant_provisoir - computedTotalReel;

    const bonReel = await prisma.bonReel.create({
      data: {
        bon_provisoir_id: bpId,
        dossier_id: bonProvisoir.dossier_id,
        montant_provisoir,
        montant_reel: computedTotalReel,
        ecart,
        items_json: finalItemsJson,
        observations: observations || null,
        soumis_par_id: req.session.userId
      }
    });

    // Update Dossier Status to FACTURATION
    await prisma.dossier.update({
      where: { id: bonProvisoir.dossier_id },
      data: { pipeline_status: "FACTURATION" }
    });

    try {
      // Mark operational justification task as completed
      await prisma.tache.updateMany({
        where: { dossier_id: bonProvisoir.dossier_id, titre: `🧾 Régularisation - Bon Provisoire ${bonProvisoir.numero}`, archive: false },
        data: { etat: "FAIT" }
      });
    } catch (tError) {
      console.error("Erreur marquage tâche régularisation complétée :", tError);
    }

    await logActivity(req.session.userId, "BON_REEL_SOUMIS", "BonReel", bonReel.id);
    await notify("finances", "Justification de Bon soumis (Bon Réel)", `Un bon réel a été soumis pour le bon provisoire ${bonProvisoir.numero}. Écart : ${ecart} F.`);

    req.session.success_msg = `Justificatif de dépenses (Bon Réel) enregistré avec succès (Total réel : ${computedTotalReel.toLocaleString('fr-FR')} F, Écart : ${ecart.toLocaleString('fr-FR')} F).`;
    res.redirect(`/dossiers/${bonProvisoir.dossier_id}`);
  } catch (error) {
    console.error("Erreur soumission bon réel :", error);
    res.status(500).render("errors/500", { error });
  }
});

// PATCH /bons/reel/:id/confirmer - Confirmer décaissement fonds (Par agent_payeur)
router.patch("/bons/reel/:id/confirmer", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    if (!["agent_payeur", "super_admin"].includes(user.role)) {
      return res.status(403).json({ ok: false, message: "Accès non autorisé." });
    }

    const bonReelId = parseInt(req.params.id);
    const bonReel = await prisma.bonReel.findUnique({ where: { id: bonReelId } });

    if (!bonReel) {
      return res.status(404).json({ ok: false, message: "Bon réel introuvable." });
    }

    await prisma.bonReel.update({
      where: { id: bonReelId },
      data: {
        confirme_par_id: req.session.userId,
        confirme_at: new Date()
      }
    });

    await logActivity(req.session.userId, "FONDS_DECAISSES", "BonReel", bonReelId);

    res.json({ ok: true, message: "Décaissement de fonds confirmé avec succès." });
  } catch (error) {
    console.error("Erreur décaissement bon réel :", error);
    res.status(500).json({ ok: false, message: "Erreur serveur de décaissement." });
  }
});

// GET /bons/:id - Detail d'un bon d'opération
router.get("/bons/:id", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const bon = await prisma.bonProvisoir.findUnique({
      where: { id },
      include: {
        dossier: true,
        demandeur: true,
        approver: true,
        bon_reel: {
          include: {
            soumis_par: true,
            confirme_par: true
          }
        }
      }
    });

    if (!bon) {
      req.session.error_msg = "Bon d'opération introuvable.";
      return res.redirect("/dashboard");
    }

    res.render("bons/detail", {
      bon,
      title: `Détail du Bon ${bon.numero}`,
      path: "/bons",
      error_msg: req.session.error_msg || "",
      success_msg: req.session.success_msg || ""
    });
    req.session.error_msg = null;
    req.session.success_msg = null;
  } catch (error) {
    console.error("Erreur detail bon :", error);
    res.status(500).render("errors/500", { error });
  }
});

// POST /bons/provisoir/:id/tick - Cocher/Décocher un visa du top management
router.post("/bons/provisoir/:id/tick", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    if (!["direction", "super_admin"].includes(user.role)) {
      return res.status(403).json({ ok: false, message: "Accès refusé. Réservé à la Direction." });
    }

    const bonId = parseInt(req.params.id);
    const { tick } = req.body; // 'pdg', 'dg', 'dga', 'daf' ou 'audit'
    if (!["pdg", "dg", "dga", "daf", "audit"].includes(tick)) {
      return res.status(400).json({ ok: false, message: "Type de visa invalide." });
    }

    const bon = await prisma.bonProvisoir.findUnique({
      where: { id: bonId },
      include: { demandeur: true }
    });
    if (!bon) {
      return res.status(404).json({ ok: false, message: "Bon provisoire introuvable." });
    }

    const field = `tick_${tick}`;
    const byField = `tick_${tick}_by`;
    const currentValue = (bon as any)[field];
    const newValue = !currentValue;

    const updateData: any = {};
    updateData[field] = newValue;
    updateData[byField] = newValue ? `${user.nom} ${user.prenom || ""}` : null;

    const updatedBon = await prisma.bonProvisoir.update({
      where: { id: bonId },
      data: updateData
    });

    // Check if ALL 5 ticks are now true
    const allApproved = updatedBon.tick_pdg && updatedBon.tick_dg && updatedBon.tick_dga && updatedBon.tick_daf && updatedBon.tick_audit;
    
    if (allApproved) {
      try {
        // Complete current direction visa task
        await prisma.tache.updateMany({
          where: { dossier_id: updatedBon.dossier_id, titre: `✍️ Visa requis - Bon Provisoire ${updatedBon.numero}`, archive: false },
          data: { etat: "FAIT" }
        });
        
        // Create new cashier decaissement task
        await createAutoTask(updatedBon.dossier_id, `💵 Décaissement - Bon Provisoire ${updatedBon.numero}`, `Tous les visas obligatoires de Direction ont été obtenus. Ce bon est désormais prêt pour décaissement de fonds physiques à la Caisse.`, "agent_payeur");
      } catch (tError) {
        console.error("Erreur mise à jour tâches lors de l'approbation globale :", tError);
      }
    }

    await logActivity(
      req.session.userId, 
      `VISA_${tick.toUpperCase()}_${newValue ? "APPLIQUE" : "RETIRE"}`, 
      "BonProvisoir", 
      bonId
    );

    res.json({ 
      ok: true, 
      allApproved, 
      bon: updatedBon,
      message: `Visa ${tick.toUpperCase()} mis à jour.` 
    });
  } catch (error) {
    console.error("Erreur visa top management :", error);
    res.status(500).json({ ok: false, message: "Erreur de mise à jour du visa." });
  }
});

// GET /bons/:id/pdf - Télécharger/consulter le PDF du bon de décaissement
router.get("/bons/:id/pdf", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const bon = await prisma.bonProvisoir.findUnique({
      where: { id },
      include: {
        dossier: {
          include: { client: true }
        },
        demandeur: true,
        approver: true,
        bon_reel: {
          include: {
            soumis_par: true,
            confirme_par: true
          }
        }
      }
    });

    if (!bon) {
      req.session.error_msg = "Bon d'opération introuvable.";
      return res.redirect("/dashboard");
    }

    // Chercher le responsable du service correspondant (par son rôle)
    let serviceLabel = "Département Logistique";
    let responsableNom = "Yannick Abega (Admin)";

    if (bon.service === "acconage") {
      serviceLabel = "Service d'Acconage & Manutention";
      const resp = await prisma.user.findFirst({ where: { role: "acconage" } });
      if (resp) {
        responsableNom = `${resp.prenom || ""} ${resp.nom}`.trim();
      } else {
        responsableNom = "Responsable Acconage";
      }
    } else if (bon.service === "enlevement") {
      serviceLabel = "Service d'Enlèvement & Livraison";
      const resp = await prisma.user.findFirst({ where: { role: "enlevement" } });
      if (resp) {
        responsableNom = `${resp.prenom || ""} ${resp.nom}`.trim();
      } else {
        responsableNom = "Responsable Enlèvement";
      }
    } else if (bon.service === "super_admin" || bon.service === "admin") {
      serviceLabel = "Direction des Opérations";
      responsableNom = "Yannick Abega (Directeur Général)";
    }

    // Set content attachment header
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="BON-${bon.numero}.pdf"`);

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    doc.pipe(res);

    // Header
    doc.fillColor("#0F172A").fontSize(18).text("YM-TRANSIT ERP", { align: "center" });
    doc.fontSize(10).fillColor("#475569").text("Transit & Douane • Cameroun Port Autonome de Douala", { align: "center" });
    doc.moveDown(1.5);

    // Line separator
    doc.strokeColor("#E2E8F0").lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(1.5);

    // Title Block
    doc.fillColor("#1E3A8A").fontSize(14).text(`BON PROVISOIRE DE DECAISSEMENT : ${bon.numero}`, { align: "center", underline: true });
    doc.moveDown(1);

    // Metadata section (Grid layout via coordinates)
    const startY = doc.y;
    doc.fillColor("#334155").fontSize(10);
    
    doc.text(`Dossier N°:`, 50, startY);
    doc.fillColor("#0F172A").text(`${bon.dossier.numero}`, 160, startY);

    doc.fillColor("#334155").text(`Client :`, 50, startY + 15);
    doc.fillColor("#0F172A").text(`${bon.dossier.client.nom}`, 160, startY + 15);

    doc.fillColor("#334155").text(`Demandeur :`, 50, startY + 30);
    doc.fillColor("#0F172A").text(`${bon.demandeur.prenom || ""} ${bon.demandeur.nom}`, 160, startY + 30);

    doc.fillColor("#334155").text(`Service Émetteur :`, 50, startY + 45);
    doc.fillColor("#0F172A").text(`${serviceLabel}`, 160, startY + 45);

    doc.fillColor("#334155").text(`Responsable Service :`, 50, startY + 60);
    doc.fillColor("#0F172A").text(`${responsableNom}`, 160, startY + 60);

    doc.fillColor("#334155").text(`Objet Global :`, 50, startY + 75);
    doc.fillColor("#0F172A").text(`${bon.objet}`, 160, startY + 75);

    doc.fillColor("#334155").text(`Date Émission :`, 340, startY);
    doc.fillColor("#0F172A").text(`${new Date(bon.created_at).toLocaleDateString("fr-FR")}`, 445, startY);

    doc.fillColor("#334155").text(`État Actuel :`, 340, startY + 15);
    doc.fillColor("#1E3A8A").text(`${bon.etat}`, 445, startY + 15);

    doc.fillColor("#334155").text(`Total Demandé :`, 340, startY + 30);
    doc.fillColor("#1E3A8A").text(`${bon.montant_demande.toLocaleString("fr-FR")} F CFA`, 445, startY + 30);

    doc.moveDown(6.5);

    // Itemized Details Table
    doc.fillColor("#0F172A").fontSize(12).text("Détails des imputations et charges demandées", 50, doc.y, { underline: true });
    doc.moveDown(0.5);

    // Table Header
    let currentY = doc.y;
    doc.rect(50, currentY, 495, 20).fill("#F1F5F9");
    doc.fillColor("#334155").fontSize(9);
    doc.text("Désignation des dépenses", 60, currentY + 6);
    doc.text("Montant demandé", 430, currentY + 6, { width: 100, align: "right" });
    doc.moveDown(1.5);

    // Table Rows
    let itemsList = [];
    if (bon.items_json) {
      try {
        itemsList = JSON.parse(bon.items_json);
      } catch (err) {}
    } else {
      itemsList = [{ designation: bon.objet, montant: bon.montant_demande }];
    }

    currentY = doc.y;
    itemsList.forEach((it: any) => {
      doc.text(it.designation, 60, currentY + 6);
      doc.text(`${(it.montant || 0).toLocaleString("fr-FR")} F CFA`, 430, currentY + 6, { width: 100, align: "right" });
      currentY += 20;
    });

    // Total Row
    doc.rect(50, currentY, 495, 20).fill("#E2E8F0");
    doc.fillColor("#0F172A").fontSize(10);
    doc.text("TOTAL GENERAL", 60, currentY + 5);
    doc.text(`${bon.montant_demande.toLocaleString("fr-FR")} F CFA`, 430, currentY + 5, { width: 100, align: "right" });

    doc.moveDown(3);

    // Signature control checklist box (Top management controls)
    doc.fontSize(11).text("Contrôles réglementaires et Visas du Top Management", 50, doc.y, { underline: true });
    doc.moveDown(0.5);

    currentY = doc.y;
    // We draw a compact block with the ticks status
    doc.rect(50, currentY, 495, 75).strokeColor("#CBD5E1").lineWidth(1).stroke();

    doc.fontSize(9).fillColor("#334155");
    
    // Ticks drawing
    const drawTick = (label: string, isChecked: boolean, by: string | null, x: number, y: number) => {
      doc.rect(x, y, 10, 10).strokeColor("#334155").lineWidth(1).stroke();
      if (isChecked) {
        doc.fillColor("#10B981").text("X", x + 2, y + 1);
      }
      doc.fillColor("#334155").text(label, x + 15, y + 1);
      if (by) {
        doc.fillColor("#64748B").fontSize(7).text(`Par: ${by}`, x + 15, y + 12);
        doc.fontSize(9);
      }
    };

    drawTick("Visa PDG (Président DG)", bon.tick_pdg, bon.tick_pdg_by, 65, currentY + 15);
    drawTick("Visa DG (Directeur Gén.)", bon.tick_dg, bon.tick_dg_by, 220, currentY + 15);
    drawTick("Visa DGA (Directeur GA)", bon.tick_dga, bon.tick_dga_by, 380, currentY + 15);
    drawTick("Visa DAF (Finances)", bon.tick_daf, bon.tick_daf_by, 140, currentY + 45);
    drawTick("Visa Audit Interne", bon.tick_audit, bon.tick_audit_by, 300, currentY + 45);

    doc.moveDown(5);

    // Footer signature spaces
    currentY = doc.y;
    if (currentY > 700) {
      doc.addPage();
      currentY = 50;
    }
    doc.fontSize(10).fillColor("#475569");
    doc.text("Signature du demandeur", 50, currentY, { align: "left" });
    doc.text("Signature de l'Ordonnateur", 350, currentY, { align: "right" });

    // End stream
    doc.end();
  } catch (error) {
    console.error("Erreur génération PDF bon :", error);
    res.status(500).send("Erreur de génération de l'imprimé PDF.");
  }
});

// GET /api/notifications/poll - Obtenir les alertes temps-réel adaptées au rôle de l'utilisateur connecté
router.get("/api/notifications/poll", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    if (!user) {
      return res.json({ ok: false, notifications: [] });
    }

    const notifications: any[] = [];

    if (user.role === "agent_payeur") {
      // Pour l'agent payeur (La Caisse) : Bons Provisoires validés par la direction mais non encore décaissés
      const readyBons = await prisma.bonProvisoir.findMany({
        where: {
          etat: "EN_ATTENTE",
          tick_pdg: true,
          tick_dg: true,
          tick_dga: true,
          tick_daf: true,
          tick_audit: true
        },
        include: { dossier: { select: { numero: true } } }
      });

      readyBons.forEach(bon => {
        notifications.push({
          id: `bp-${bon.id}-ready`,
          title: "💵 Décaissement en attente à la Caisse",
          content: `Le bon provisoire ${bon.numero} (${bon.montant_demande.toLocaleString("fr-FR")} FCFA) est validé par tous les Directeurs et prêt pour paiement aux guichets.`,
          url: `/dossiers/${bon.dossier_id}`
        });
      });
    }

    if (["direction", "super_admin"].includes(user.role)) {
      // Pour le management : Bons Provisoires en attente de signatures/visas
      const pendingBons = await prisma.bonProvisoir.findMany({
        where: {
          etat: "EN_ATTENTE",
          OR: [
            { tick_pdg: false },
            { tick_dg: false },
            { tick_dga: false },
            { tick_daf: false },
            { tick_audit: false }
          ]
        },
        include: { dossier: { select: { numero: true } } }
      });

      pendingBons.forEach(bon => {
        notifications.push({
          id: `bp-${bon.id}-visa-pending`,
          title: "✍️ Visa requis pour Décaissement",
          content: `Le bon provisoire ${bon.numero} (${bon.montant_demande.toLocaleString("fr-FR")} FCFA) nécessite de nouveaux visas.`,
          url: `/dossiers/${bon.dossier_id}`
        });
      });
    }

    if (["acconage", "enlevement"].includes(user.role)) {
      // Pour le demandeur : Bons provisoires approuvés ou rejetés récemment
      const myBons = await prisma.bonProvisoir.findMany({
        where: {
          demandeur_id: user.id,
          etat: { in: ["APPROUVE", "REJETE"] }
        },
        orderBy: { approved_at: "desc" },
        take: 3
      });

      myBons.forEach(bon => {
        if (bon.etat === "APPROUVE") {
          notifications.push({
            id: `bp-${bon.id}-approved`,
            title: "✅ Bon provisoire approuvé & décaissé",
            content: `Le bon ${bon.numero} que vous avez demandé a été approuvé et décaissé par la caisse !`,
            url: `/dossiers/${bon.dossier_id}`
          });
        } else if (bon.etat === "REJETE") {
          notifications.push({
            id: `bp-${bon.id}-rejected`,
            title: "❌ Bon provisoire rejeté",
            content: `Le bon ${bon.numero} a été rejeté. Motif : ${bon.motif_rejet || "Non spécifié"}.`,
            url: `/dossiers/${bon.dossier_id}`
          });
        }
      });
    }

    return res.json({ ok: true, notifications });
  } catch (error) {
    console.error("Erreur de polling des notifications :", error);
    return res.json({ ok: false, notifications: [] });
  }
});

export default router;
