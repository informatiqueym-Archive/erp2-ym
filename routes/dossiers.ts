import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs" ;
import { requireAuth, requireModule } from "./rbac";
import prisma from "../lib/prismaClient";

const router = Router();

// Protéger toutes les routes de ce fichier avec la restriction de module dossiers
router.use(requireAuth, requireModule("dossiers"));

// Config Multer pour gestion des pièces jointes dossiers
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const id = req.params.id;
    const dir = path.join(process.cwd(), "uploads", "dossiers", id);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    // Nom propre sécurisé pour éviter tout conflit
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const cleanedName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${uniqueSuffix}-${cleanedName}`);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Uniquement les fichiers PDF
    const filetypes = /pdf$/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Seuls les fichiers PDF sont acceptés !"));
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Helper de log
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
    console.error("Erreur log dossiers route :", error);
  }
}

// GET /dossiers - Index (liste complète avec recherche Javascript client-side et dropdowns)
router.get("/dossiers", requireAuth, async (req: any, res: any) => {
  try {
    const { client_id, etat } = req.query;

    const filterObj: any = {};
    if (client_id) {
      filterObj.client_id = parseInt(client_id);
    }
    if (etat) {
      filterObj.etat = etat;
    }

    const [dossiers, clients] = await Promise.all([
      prisma.dossier.findMany({
        where: filterObj,
        include: {
          client: true,
          taches: true,
        },
        orderBy: {
          created_at: "desc",
        },
      }),
      prisma.client.findMany({ orderBy: { nom: "asc" } }),
    ]);

    res.render("dossiers/index", {
      dossiers,
      clients,
      selectedClientId: client_id || "",
      selectedEtat: etat || "",
      title: "Gestion des Dossiers de Transit",
    });
  } catch (error) {
    console.error("Erreur listing dossiers :", error);
    res.status(500).send("Erreur lors de la récupération des dossiers.");
  }
});

// GET /archives & GET /dossiers/archives - Liste des dossiers archivés définitivement
const handleGetArchives = async (req: any, res: any) => {
  try {
    const dossiers = await prisma.dossier.findMany({
      where: {
        pipeline_status: "ARCHIVE"
      },
      include: {
        client: true,
        taches: true
      },
      orderBy: {
        archived_at: "desc"
      }
    });

    res.render("dossiers/archives", {
      dossiers,
      title: "Archives des Dossiers Logistiques",
    });
  } catch (error) {
    console.error("Erreur listing archives :", error);
    res.status(500).send("Erreur lors de la récupération des archives d'expédition.");
  }
};

router.get("/archives", requireAuth, handleGetArchives);
router.get("/dossiers/archives", requireAuth, handleGetArchives);

// GET /dossiers/create - Formulaire de création de dossiers
router.get("/dossiers/create", requireAuth, async (req: any, res: any) => {
  try {
    const user = req.session.user;
    if (user.role !== "secretariat" && user.role !== "super_admin") {
      req.session.error_msg = "Accès non autorisé : seul le secrétariat administratif (ou le Super Administrateur) peut ouvrir un nouveau dossier.";
      return res.redirect("/dossiers");
    }

    const clients = await prisma.client.findMany({ orderBy: { nom: "asc" } });
    res.render("dossiers/create", {
      clients,
      title: "Ouvrir un Dossier de Transit Maritime & Douanier",
    });
  } catch (error) {
    console.error("Erreur init formulaire dossier :", error);
    res.status(500).send("Erreur d'initialisation du formulaire.");
  }
});

// POST /dossiers/create - Enregistrement d'un dossier (et route compatible /dossiers/new)
const handleDossierCreation = async (req: any, res: any) => {
  try {
    const user = req.session.user;
    if (user.role !== "secretariat" && user.role !== "super_admin") {
      req.session.error_msg = "Accès non autorisé : seul le secrétariat administratif (ou le Super Administrateur) peut ouvrir un nouveau dossier.";
      return res.redirect("/dossiers");
    }

    const { client_id, numero, port, nature, etat, bl, contenu, droits_douane, validation, valeur_douane, representant } = req.body;

    if (!client_id || !numero || !port || !nature || !bl) {
      req.session.error_msg = "Veuillez remplir correctement tous les champs obligatoires (*), y compris le N° de BL.";
      return res.redirect("/dossiers/create");
    }

    const clientIdParsed = parseInt(client_id);

    // Vérifier l'unicité du numéro de dossier
    const existing = await prisma.dossier.findUnique({
      where: { numero: numero.trim() },
    });

    if (existing) {
      req.session.error_msg = `Le numéro de dossier ${numero} est déjà utilisé par une autre expédition.`;
      return res.redirect("/dossiers/create");
    }

    const rawDroits = parseFloat(droits_douane);
    const rawValeur = parseFloat(valeur_douane);
    const parsedDroits = (droits_douane && !isNaN(rawDroits)) ? rawDroits : null;
    const parsedValeur = (valeur_douane && !isNaN(rawValeur)) ? rawValeur : null;
    const validationBool = (validation === 'true' || validation === true || validation === 'on');

    let newDossier;
    try {
      newDossier = await prisma.dossier.create({
        data: {
          client_id: clientIdParsed,
          numero: numero.trim(),
          port: port,
          nature: nature,
          bl: bl.trim(),
          etat: etat || "OUVERT",
          contenu: contenu || null,
          droits_douane: parsedDroits,
          validation: validationBool,
          valeur_douane: parsedValeur,
          representant: representant ? representant.trim() : null,
          pipeline_status: "CREE"
        },
      });
    } catch (e: any) {
      if (e.message && e.message.includes("Unknown argument")) {
        newDossier = await prisma.dossier.create({
          data: {
            client_id: clientIdParsed,
            numero: numero.trim(),
            port: port,
            nature: nature,
            bl: bl.trim(),
            etat: etat || "OUVERT",
            contenu: contenu || null,
            droits_douane: parsedDroits,
            validation: validationBool,
            valeur_douane: parsedValeur
          },
        });
      } else {
        throw e;
      }
    }

    await logActivity(
      req.session.userId,
      "OUVERTURE_DOSSIER",
      "Dossier",
      newDossier.id
    );

    req.session.success_msg = `Dossier ${newDossier.numero} ouvert avec succès pour le suivi maritime !`;
    res.redirect(`/dossiers/${newDossier.id}`);
  } catch (error: any) {
    console.error("Erreur de création du dossier :", error);
    req.session.error_msg = "Une erreur est survenue lors de la création du dossier: " + (error.message || error);
    res.redirect("/dossiers/create");
  }
};

router.post("/dossiers/create", requireAuth, handleDossierCreation);
router.post("/dossiers/new", requireAuth, handleDossierCreation);

// POST /dossiers/:id/update-custom - Mettre à jour les détails de douane, marchandises, client et conteneur
router.post("/dossiers/:id/update-custom", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const dossier = await prisma.dossier.findUnique({ where: { id } });
    
    if (!dossier) {
      req.session.error_msg = "Dossier introuvable.";
      return res.redirect("/dossiers");
    }

    const { client_id, bl, contenu, droits_douane, validation, valeur_douane } = req.body;
    const data: any = {};

    // Groupe 1 : Informations d'origine/Création (client_id, bl, contenu)
    const wantsToChangeGroup1 = 
      (client_id !== undefined && parseInt(client_id) !== dossier.client_id) ||
      (bl !== undefined && bl.trim() !== (dossier.bl || "")) ||
      (contenu !== undefined && (contenu ? contenu.trim() : "") !== (dossier.contenu || ""));

    if (wantsToChangeGroup1) {
      const userObj = req.session.user;
      if (userObj.role !== "secretariat" && userObj.role !== "super_admin") {
        req.session.error_msg = "Accès refusé : Seul le secrétariat administratif (ou le Super Administrateur) peut modifier les informations d'origine de ce dossier.";
        return res.redirect(`/dossiers/${id}`);
      }
      if (dossier.pipeline_status !== "CREE") {
        req.session.error_msg = "Modification refusée : Les champs initiaux (BL, Client, Contenu) sont verrouillés. Veuillez soumettre une Demande de Correction (Retour arrière) pour les modifier.";
        return res.redirect(`/dossiers/${id}`);
      }
      if (client_id) {
        data.client_id = parseInt(client_id);
      }
      if (bl !== undefined) {
        data.bl = bl ? bl.trim() : "";
      }
      if (contenu !== undefined) {
        data.contenu = contenu ? contenu.trim() : null;
      }
    }

    // Groupe 2 : Informations de validation douanière (droits_douane, valeur_douane, validation)
    const parsedDroits = droits_douane !== undefined ? (droits_douane ? parseFloat(droits_douane) : null) : undefined;
    const parsedValeur = valeur_douane !== undefined ? (valeur_douane ? parseFloat(valeur_douane) : null) : undefined;
    const isValChecked = (validation === 'true' || validation === 'on' || validation === true);

    const wantsToChangeGroup2 =
      (parsedDroits !== undefined && parsedDroits !== dossier.droits_douane) ||
      (parsedValeur !== undefined && parsedValeur !== dossier.valeur_douane) ||
      (isValChecked !== dossier.validation);

    if (wantsToChangeGroup2) {
      const userObj = req.session.user;
      if (userObj.role !== "validation" && userObj.role !== "validation_role" && userObj.role !== "super_admin") {
        req.session.error_msg = "Accès refusé : Seul le pôle de Validation / Contrôle de Conformité (ou le Super Administrateur) peut modifier les détails douaniers.";
        return res.redirect(`/dossiers/${id}`);
      }
      if (dossier.pipeline_status !== "VALIDATION") {
        req.session.error_msg = "Modification refusée : Les informations douanières sont validées et verrouillées. Veuillez soumettre une Demande de Correction (Retour arrière) pour les modifier.";
        return res.redirect(`/dossiers/${id}`);
      }
      if (parsedDroits !== undefined) {
        data.droits_douane = parsedDroits;
      }
      if (parsedValeur !== undefined) {
        data.valeur_douane = parsedValeur;
      }
      data.validation = isValChecked;
    }

    if (Object.keys(data).length > 0) {
      await prisma.dossier.update({
        where: { id },
        data,
      });

      await logActivity(
        req.session.userId,
        "MISE_A_JOUR_DETAILED_DOUANE",
        "Dossier",
        id
      );
      req.session.success_msg = "Informations logistiques et douanières actualisées.";
    } else {
      req.session.success_msg = "Aucun changement détecté ou modifications autorisées requises.";
    }

    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur mise à jour infos douanières :", error);
    req.session.error_msg = "Erreur d'enregistrement des modifications.";
    res.redirect(`/dossiers/${req.params.id}`);
  }
});

// GET /dossiers/:id - Fiche détaillée (STAR)
router.get("/dossiers/:id", requireAuth, async (req: any, res: any) => {
  try {
    const folderId = parseInt(req.params.id);

    const dossier = await prisma.dossier.findUnique({
      where: { id: folderId },
      include: {
        client: true,
        taches: {
          include: {
            intervenant: true,
            subtasks: true,
          },
          orderBy: {
            created_at: "asc",
          },
        },
        bons_provisoir: {
          include: {
            demandeur: { select: { nom: true, prenom: true, role: true } },
            approver: { select: { nom: true, prenom: true } },
            bon_reel: {
              include: {
                soumis_par: { select: { nom: true, prenom: true } },
                confirme_par: { select: { nom: true, prenom: true } }
              }
            }
          },
          orderBy: {
            created_at: "desc"
          }
        },
        bons_reel: true
      },
    });

    if (!dossier) {
      req.session.error_msg = "Dossier de transit introuvable.";
      return res.redirect("/dossiers");
    }

    // 1. Invoices (Documents) related checking
    // Match by client to speed up, then filter matching dossier number inside document.numero or line.description
    const allDocs = await prisma.document.findMany({
      where: {
        client_id: dossier.client_id,
      },
      include: {
        lines: true,
        payments: true,
      },
      orderBy: {
        created_at: "desc",
      }
    });

    const linkedInvoices = allDocs.filter(doc => {
      const matchInNum = doc.numero.toUpperCase().includes(dossier.numero.toUpperCase());
      const matchInLines = doc.lines.some(l => l.description.toUpperCase().includes(dossier.numero.toUpperCase()));
      return matchInNum || matchInLines;
    });

    // 2. Attachments files reading
    const uploadDirPath = path.join(process.cwd(), "uploads", "dossiers", String(dossier.id));
    const attachments: Array<{ name: string; size: string; uploadedAt: string }> = [];

    if (fs.existsSync(uploadDirPath)) {
      const files = fs.readdirSync(uploadDirPath);
      files.forEach(f => {
        const stats = fs.statSync(path.join(uploadDirPath, f));
        attachments.push({
          name: f,
          size: `${(stats.size / (1024 * 1024)).toFixed(2)} MB`,
          uploadedAt: stats.mtime.toLocaleDateString("fr-FR"),
        });
      });
    }

    // 3. Activity timelines logs
    // Include logs specifically pointing to this dossier or to any of its tasks
    const taskIds = dossier.taches.map(t => t.id);
    const logs = await prisma.activityLog.findMany({
      where: {
        OR: [
          { entity: "Dossier", entity_id: String(dossier.id) },
          { entity: "Tache", entity_id: { in: taskIds.map(String) } },
        ],
      },
      include: {
        user: true,
      },
      orderBy: {
        created_at: "desc",
      },
    });

    const timeline = await prisma.activityLog.findMany({
      where: { entity: "dossier", entity_id: String(folderId) },
      include: { user: { select: { nom: true } } },
      orderBy: { created_at: "desc" },
      take: 40
    });

    // Envoi de tous les agents pour l'assignation de tâches rapides
    const [users, clients] = await Promise.all([
      prisma.user.findMany({
        where: { actif: true },
        orderBy: { nom: "asc" },
      }),
      prisma.client.findMany({
        orderBy: { nom: "asc" },
      })
    ]);

    res.render("dossiers/detail", {
      dossier,
      linkedInvoices,
      attachments,
      logs,
      timeline,
      users,
      clients,
      title: `Suivi Dossier - ${dossier.numero}`,
    });
  } catch (error: any) {
    console.error("Erreur chargement détail dossier :", error);
    res.status(500).send(`Erreur lors de la récupération de la fiche détaillée. Détails de l'erreur interne: ${error?.message || error}\n\nStacktrace:\n${error?.stack}`);
  }
});

// POST /dossiers/:id/upload - Upload de pièce jointe PDF
router.post("/dossiers/:id/upload", requireAuth, (req: any, res: any) => {
  upload.single("pdf_file")(req, res, async function (err: any) {
    const id = req.params.id;
    if (err) {
      req.session.error_msg = `Échec de l'import : ${err.message}`;
      return res.redirect(`/dossiers/${id}`);
    }

    if (!req.file) {
      req.session.error_msg = "Veuillez sélectionner un document PDF valide à importer.";
      return res.redirect(`/dossiers/${id}`);
    }

    await prisma.activityLog.create({
      data: {
        user_id: req.session.userId,
        action: 'fichier.uploaded',
        entity: 'dossier',
        entity_id: String(id),
        meta: JSON.stringify({ filename: req.file.originalname })
      }
    });

    await logActivity(
      req.session.userId,
      `IMPORT_PIECE_JOINTE_${req.file.filename.split("-").slice(2).join("-")}`,
      "Dossier",
      parseInt(id)
    );

    req.session.success_msg = `Pièce jointe importée avec succès : ${req.file.originalname}`;
    res.redirect(`/dossiers/${id}`);
  });
});

// GET /dossiers/:id/download/:filename - Téléchargement d'une pièce jointe
router.get("/dossiers/:id/download/:filename", requireAuth, (req: any, res: any) => {
  try {
    const id = req.params.id;
    const filename = req.params.filename;
    
    // Protection contre le path-traversal
    const safeFilename = path.basename(filename);
    const filePath = path.join(process.cwd(), "uploads", "dossiers", id, safeFilename);

    if (fs.existsSync(filePath)) {
      res.download(filePath, safeFilename);
    } else {
      res.status(404).send("Le fichier demandé n'existe pas ou a été retiré.");
    }
  } catch (error) {
    console.error("Erreur download :", error);
    res.status(500).send("Erreur interne du système lors du téléchargement.");
  }
});

// POST /dossiers/update-status/:id - Changement d'état logistique d'un dossier
router.post("/dossiers/update-status/:id", requireAuth, async (req: any, res: any) => {
  try {
    const folderId = parseInt(req.params.id);
    const { etat } = req.body;

    if (!etat) {
      req.session.error_msg = "État invalide.";
      return res.redirect("/dossiers");
    }

    await prisma.dossier.update({
      where: { id: folderId },
      data: { etat },
    });

    await logActivity(
      req.session.userId,
      `STATUS_DOSSIER_MOD_TO_${etat}`,
      "Dossier",
      folderId
    );

    req.session.success_msg = `Statut du dossier actualisé à : "${etat}"`;
    res.redirect(`/dossiers/${folderId}`);
  } catch (error) {
    console.error("Erreur statut dossier :", error);
    res.status(500).send("Erreur de traitement.");
  }
});

// POST /dossiers/delete/:id - Suppression d'un dossier
router.post("/dossiers/delete/:id", requireAuth, async (req: any, res: any) => {
  try {
    const folderId = parseInt(req.params.id);
    const user = req.session.user;

    if (user.role !== "super_admin") {
      req.session.error_msg = "Accès refusé : Seul le Super Administrateur peut supprimer définitivement un dossier.";
      return res.redirect(`/dossiers/${folderId}`);
    }

    const ds = await prisma.dossier.findUnique({ where: { id: folderId } });
    if (!ds) {
      req.session.error_msg = "Dossier introuvable.";
      return res.redirect("/dossiers");
    }

    await prisma.dossier.delete({
      where: { id: folderId },
    });

    await logActivity(
      req.session.userId,
      `SUPPRESSION_DOSSIER_${ds.numero}`,
      "Dossier",
      folderId
    );

    // Supprimer aussi le dossier d'uploads correspondant physique
    const uploadDirPath = path.join(process.cwd(), "uploads", "dossiers", String(folderId));
    if (fs.existsSync(uploadDirPath)) {
      fs.rmSync(uploadDirPath, { recursive: true, force: true });
    }

    req.session.success_msg = `Dossier ${ds.numero} supprimé du système logistique.`;
    res.redirect("/dossiers");
  } catch (error) {
    console.error("Erreur suppression dossier :", error);
    res.status(500).send("Erreur de suppression.");
  }
});

// POST /dossiers/:id/taches/new - Ajouter un jalon d'étape rapide
router.post("/dossiers/:id/taches/new", requireAuth, async (req: any, res: any) => {
  const dossierId = parseInt(req.params.id);
  try {
    const { titre, intervenant_id, deadline, observations } = req.body;

    if (!titre) {
      req.session.error_msg = "Le titre de la tâche est obligatoire.";
      return res.redirect(`/dossiers/${dossierId}`);
    }

    const assignedAgentId = intervenant_id ? parseInt(intervenant_id) : null;
    const limitDate = deadline ? new Date(deadline) : null;

    const tache = await prisma.tache.create({
      data: {
        dossier_id: dossierId,
        titre: titre.trim(),
        intervenant_id: assignedAgentId,
        etat: "EN_COURS",
        observations: observations ? observations.trim() : "",
        deadline: limitDate,
      },
    });

    await logActivity(
      req.session.userId,
      "CREATION_TACHE_RAPIDE",
      "Tache",
      tache.id
    );

    req.session.success_msg = `Tâche "${titre}" ajoutée pour ce dossier.`;
    res.redirect(`/dossiers/${dossierId}`);
  } catch (error) {
    console.error("Erreur tâche rapide :", error);
    req.session.error_msg = "Une erreur est survenue lors de la création.";
    res.redirect(`/dossiers/${dossierId}`);
  }
});

// POST /dossiers/:id/taches/:tacheId/modifier - Mettre à jour une tâche depuis le dossier
router.post("/dossiers/:id/taches/:tacheId/modifier", requireAuth, async (req: any, res: any) => {
  try {
    const dossierId = parseInt(req.params.id);
    const tacheId = parseInt(req.params.tacheId);
    const { delete_task, etat, titre, observations, intervenant_id } = req.body;

    const previousTask = await prisma.tache.findUnique({ where: { id: tacheId } });
    if (!previousTask) {
      return res.status(404).send("Tâche introuvable.");
    }

    // Suppression demandée
    if (delete_task === "yes") {
      await prisma.tache.delete({ where: { id: tacheId } });
      await logActivity(req.session.userId, "SUPPRESSION_TACHE", "Tache", tacheId);
      req.session.success_msg = "Tâche retirée du dossier.";
      return res.redirect(`/dossiers/${dossierId}`);
    }

    const updateData: any = {};
    if (etat) updateData.etat = etat;
    if (titre) updateData.titre = titre;
    if (observations !== undefined) updateData.observations = observations;
    if (intervenant_id !== undefined) {
      updateData.intervenant_id = intervenant_id ? parseInt(intervenant_id) : null;
    }

    await prisma.tache.update({
      where: { id: tacheId },
      data: updateData,
    });

    if (etat && previousTask.etat !== etat) {
      await prisma.activityLog.create({
        data: {
          user_id: req.session.userId,
          action: 'tache.status',
          entity: 'dossier',
          entity_id: String(dossierId),
          meta: JSON.stringify({
            titre: previousTask.titre,
            from: previousTask.etat,
            to: etat
          })
        }
      });
    }

    await logActivity(
      req.session.userId,
      `MODIFICATION_TACHE_${tacheId}`,
      "Tache",
      tacheId
    );

    req.session.success_msg = "Tâche d'expédition actualisée.";
    res.redirect(`/dossiers/${dossierId}`);
  } catch (error) {
    console.error("Erreur modif tâche dossier :", error);
    res.status(500).send("Erreur de traitement.");
  }
});

// Helper pour créer automatiquement une tâche Kanban lors d'un transition de flux
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

  // POST /dossiers/:id/pipeline/soumettre-guce - Soumettre au GUCE (Secrétariat, Super Admin)
router.post("/dossiers/:id/pipeline/soumettre-guce", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = req.session.user;
    if (!["secretariat", "super_admin", "pdg", "dg", "dga"].includes(user.role)) {
      req.session.error_msg = "Seul le secrétariat, l'administration ou un administrateur peut soumettre au GUCE.";
      return res.redirect(`/dossiers/${id}`);
    }

    const dossier = await prisma.dossier.update({
      where: { id },
      data: { pipeline_status: "GUCE" }
    });

    await logActivity(req.session.userId, "DOSSIER_SOUMIS_GUCE", "Dossier", id);
    
    // Création d'une tâche pour le GUCE
    await createAutoTask(id, `🇬🇺 Formalités GUCE - Dossier ${dossier.numero}`, `Paiement des frais Assurance, DESC, RVC et attachement des quittances pour manifestation.`, "guce");

    req.session.success_msg = "Dossier soumis au GUCE avec succès.";
    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur soumission GUCE pipeline status :", error);
    res.status(500).send("Erreur serveur.");
  }
});

// POST /dossiers/:id/pipeline/valider-guce - Valider GUCE et soumettre pour Validation CAMCIS (GUCE, Super Admin)
router.post("/dossiers/:id/pipeline/valider-guce", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = req.session.user;
    if (!["guce", "super_admin", "pdg", "dg", "dga", "auditeur1"].includes(user.role)) {
      req.session.error_msg = "Seul le pôle GUCE, l'administration ou un administrateur peut valider cette étape.";
      return res.redirect(`/dossiers/${id}`);
    }

    const { assurance_montant, desc_montant, rvc_montant, manifeste_checked } = req.body;
    const notesLog = `Assurance: ${assurance_montant || 0} FCFA | DESC: ${desc_montant || 0} FCFA | RVC: ${rvc_montant || 0} FCFA | Manifesté: ${manifeste_checked === 'on' || manifeste_checked === true ? "OUI" : "NON"}`;

    const dossier = await prisma.dossier.update({
      where: { id },
      data: { pipeline_status: "VALIDATION" }
    });

    await logActivity(req.session.userId, "DOSSIER_VALIDE_GUCE", "Dossier", `${id} - Détails: ${notesLog}`);
    
    // Création d'une tâche de validation pour le pôle conformité / validation
    await createAutoTask(id, `📁 Contrôle de Conformité - Dossier ${dossier.numero}`, `Le dossier ${dossier.numero} est prêt pour votre visa de validation réglementaire CAMCIS.`, "validation");

    req.session.success_msg = `Formalités GUCE validées (${notesLog}). Soumis à la validation conformité CAMCIS.`;
    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur validation GUCE pipeline status :", error);
    res.status(500).send("Erreur serveur.");
  }
});

// POST /dossiers/:id/pipeline/valider - Soumettre pour Validation (Ancien flux direct, conservé pour compatibilité)
router.post("/dossiers/:id/pipeline/valider", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const dossier = await prisma.dossier.update({
      where: { id },
      data: { pipeline_status: "VALIDATION" }
    });

    await logActivity(req.session.userId, "DOSSIER_SOUMIS_VALIDATION", "Dossier", id);
    await createAutoTask(id, `📁 Contrôle de Conformité - Dossier ${dossier.numero}`, `Le dossier ${dossier.numero} est prêt pour votre visa de validation réglementaire.`, "validation");

    req.session.success_msg = "Dossier soumis pour validation avec succès.";
    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur validation pipeline status :", error);
    res.status(500).send("Erreur serveur.");
  }
});

// POST /dossiers/:id/pipeline/approuver - Approuver Validation (Validation, Super Admin)
router.post("/dossiers/:id/pipeline/approuver", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = req.session.user;
    if (!["validation", "validation_role", "super_admin", "pdg", "dg", "dga", "auditeur1"].includes(user.role)) {
      req.session.error_msg = "Accès refusé : rôle non autorisé pour valider.";
      return res.redirect(`/dossiers/${id}`);
    }

    const dossier = await prisma.dossier.update({
      where: { id },
      data: { pipeline_status: "EN_TRAITEMENT" }
    });

    await logActivity(req.session.userId, "DOSSIER_VALIDATION_APPROUVEE", "Dossier", id);
    
    // Création d'une tâche d'acconage/Transit
    await createAutoTask(id, `🚢 Transit & Douane - Dossier ${dossier.numero}`, `Le dossier a été validé ! Veuillez initier les formalités d'acconage/enlèvement physique et émettre les Bons Provisoires correspondants.`, "acconage");

    req.session.success_msg = "Validation approuvée. Le dossier est maintenant en traitement d'acconage & d'enlèvement.";
    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur approuver pipeline status :", error);
    res.status(500).send("Erreur serveur.");
  }
});

// POST /dossiers/:id/pipeline/rejeter - Rejeter Validation (Validation, Super Admin)
router.post("/dossiers/:id/pipeline/rejeter", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = req.session.user;
    if (!["validation", "validation_role", "super_admin", "pdg", "dg", "dga", "auditeur1"].includes(user.role)) {
      req.session.error_msg = "Accès refusé : rôle non autorisé.";
      return res.redirect(`/dossiers/${id}`);
    }

    await prisma.dossier.update({
      where: { id },
      data: { pipeline_status: "GUCE" } // Retours arrière vont maintenant au GUCE
    });

    await logActivity(req.session.userId, "DOSSIER_VALIDATION_REJETEE", "Dossier", id);
    req.session.success_msg = "Validation rejetée. Le dossier retourne à l'étape GUCE pour corrections.";
    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur rejeter pipeline status :", error);
    res.status(500).send("Erreur serveur.");
  }
});

// POST /dossiers/:id/pipeline/facturer - Facturer (Comptable, Commercial, Super Admin)
router.post("/dossiers/:id/pipeline/facturer", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = req.session.user;
    if (!["comptable", "commercial", "super_admin", "comptable_ops", "finances", "pdg", "dg", "dga", "daf", "auditeur1"].includes(user.role)) {
      req.session.error_msg = "Accès non autorisé.";
      return res.redirect(`/dossiers/${id}`);
    }

    const dossier = await prisma.dossier.update({
      where: { id },
      data: { pipeline_status: "CLOTURE" }
    });

    await logActivity(req.session.userId, "DOSSIER_FACTURATION_TERMINEE", "Dossier", id);
    
    // Création d'une tâche de clôture financière
    await createAutoTask(id, `💰 Clôture financière - Dossier ${dossier.numero}`, `Le dossier est marqué comme facturé. Veuillez procéder aux vérifications comptables et à sa clôture d'archive définitive.`, "comptable_ops");

    req.session.success_msg = "Dossier marqué comme facturé. En attente de clôture définitive.";
    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur facturer pipeline status :", error);
    res.status(500).send("Erreur serveur.");
  }
});

// POST /dossiers/:id/pipeline/cloturer - Clôturer et Archiver (Comptable_ops, Super Admin)
router.post("/dossiers/:id/pipeline/cloturer", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const user = req.session.user;
    if (!["comptable_ops", "super_admin", "direction", "comptable", "pdg", "dg", "dga", "daf", "auditeur1"].includes(user.role)) {
      req.session.error_msg = "Seule la comptabilité, la direction ou un administrateur peut clôturer définitivement et archiver.";
      return res.redirect(`/dossiers/${id}`);
    }

    await prisma.dossier.update({
      where: { id },
      data: {
        pipeline_status: "ARCHIVE",
        archived_at: new Date()
      }
    });

    await logActivity(req.session.userId, "DOSSIER_CLOTURE_ARCHIVE", "Dossier", id);
    req.session.success_msg = "Le dossier a été clôturé définitivement et archivé avec succès.";
    res.redirect(`/dossiers/${id}`);
  } catch (error: any) {
    console.error("Erreur clôturer pipeline status :", error);
    req.session.error_msg = "Erreur lors de la clôture / archivage du dossier: " + (error.message || error);
    res.redirect(`/dossiers/${req.params.id}`);
  }
});

// POST /dossiers/:id/pipeline/retour-arriere - Demander une correction (retour à l'étape précédente)
router.post("/dossiers/:id/pipeline/retour-arriere", requireAuth, async (req: any, res: any) => {
  try {
    const id = parseInt(req.params.id);
    const { motif } = req.body;
    if (!motif || motif.trim() === "") {
      req.session.error_msg = "Veuillez fournir un motif / justification pour le retour en arrière.";
      return res.redirect(`/dossiers/${id}`);
    }

    const dossier = await prisma.dossier.findUnique({ where: { id } });
    if (!dossier) {
      req.session.error_msg = "Dossier introuvable.";
      return res.redirect("/dossiers");
    }

    const currentStatus = dossier.pipeline_status;
    const previousStatusMap: Record<string, string> = {
      "GUCE": "CREE",
      "VALIDATION": "GUCE",
      "EN_TRAITEMENT": "VALIDATION",
      "BON_PROVISOIR": "EN_TRAITEMENT",
      "BON_REEL": "EN_TRAITEMENT",
      "FACTURATION": "BON_REEL",
      "CLOTURE": "FACTURATION",
      "ARCHIVE": "CLOTURE"
    };

    const prevStatus = previousStatusMap[currentStatus];
    if (!prevStatus) {
      req.session.error_msg = `Impossible de reculer depuis le statut de création actuel (${currentStatus}).`;
      return res.redirect(`/dossiers/${id}`);
    }

    // Move status back
    await prisma.dossier.update({
      where: { id },
      data: { pipeline_status: prevStatus }
    });

    // Si on recule depuis BON_PROVISOIR, rejeter le bon provisoire en attente
    if (currentStatus === "BON_PROVISOIR") {
      await prisma.bonProvisoir.updateMany({
        where: { dossier_id: id, etat: "EN_ATTENTE" },
        data: { etat: "REJETE", motif_rejet: motif }
      });
    }

    // Record activity with the custom motif
    await logActivity(
      req.session.userId,
      `RETOUR_ETAPE_${prevStatus}_MOTIF`,
      "Dossier",
      `${id} - Motif: ${motif.trim()}`
    );

    // Mappage pour affecter automatiquement la tâche à l'acteur de l'étape précédente
    const statusToRoleMap: Record<string, string> = {
      "CREE": "secretariat",
      "GUCE": "guce",
      "VALIDATION": "validation",
      "EN_TRAITEMENT": "acconage",
      "BON_PROVISOIR": "acconage",
      "BON_REEL": "acconage",
      "FACTURATION": "facturation",
      "CLOTURE": "comptable_ops"
    };
    
    const prevRole = statusToRoleMap[prevStatus];
    let prevUser = null;
    if (prevRole) {
      prevUser = await prisma.user.findFirst({
        where: { role: prevRole, actif: true }
      });
    }

    // Créer une tâche automatique de correction
    await prisma.tache.create({
      data: {
        dossier_id: id,
        titre: `[Demande de modification] Retour à ${prevStatus} : ${motif.trim()}`,
        intervenant_id: prevUser ? prevUser.id : null,
        etat: "A_FAIRE"
      }
    });

    req.session.success_msg = `Dossier renvoyé à l'étape précédente (${prevStatus}) pour modifications.`;
    res.redirect(`/dossiers/${id}`);
  } catch (error) {
    console.error("Erreur de retour arrière pipeline :", error);
    req.session.error_msg = "Erreur serveur lors de la demande de modification.";
    res.redirect(`/dossiers/${req.params.id}`);
  }
});

export default router;
