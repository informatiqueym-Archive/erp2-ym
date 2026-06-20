import { Router } from "express";
import { requireAuth, requireModule } from "./rbac";
import prisma from "../lib/prismaClient";

const router = Router();

// Protéger toutes les routes de ce fichier avec la restriction de module taches
router.use(requireAuth, requireModule("taches"));

// Helper pour enregistrer dans le journal d'activité
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
    console.error("Erreur de journalisation d'activité taches route :", error);
  }
}

// GET /taches - Tableau de bord de tâches Kanban (Board)
router.get("/taches", requireAuth, async (req: any, res: any) => {
  try {
    const list = await prisma.tache.findMany({
      where: {
        archive: false,
      },
      include: {
        dossier: true,
        intervenant: true,
        subtasks: {
          orderBy: {
            created_at: "asc",
          },
        },
      },
      orderBy: {
        created_at: "desc",
      },
    });

    res.render("taches/board", {
      taches: list,
      title: "Tableau Kanban des Tâches",
    });
  } catch (error) {
    console.error("Erreur récup taches board :", error);
    res.status(500).send("Erreur lors de la récupération du tableau des tâches.");
  }
});

// GET /taches/archives - Liste des tâches archivées
router.get("/taches/archives", requireAuth, async (req: any, res: any) => {
  try {
    const list = await prisma.tache.findMany({
      where: {
        archive: true,
      },
      include: {
        dossier: true,
        intervenant: true,
        subtasks: {
          orderBy: {
            created_at: "asc",
          },
        },
      },
      orderBy: {
        created_at: "desc",
      },
    });

    res.render("taches/archives", {
      taches: list,
      title: "Archives des Tâches",
    });
  } catch (error) {
    console.error("Erreur récup archives tâches :", error);
    res.status(500).send("Erreur lors de la récupération des archives.");
  }
});

// POST /taches/:id/archive - Envoyer une tâche aux archives
router.post("/taches/:id/archive", requireAuth, async (req: any, res: any) => {
  try {
    const taskId = parseInt(req.params.id);
    await prisma.tache.update({
      where: { id: taskId },
      data: { archive: true },
    });

    await logActivity(
      req.session.userId,
      "ARCHIVE_TACHE",
      "Tache",
      taskId
    );

    req.session.success_msg = "Tâche envoyée aux archives avec succès.";
    res.redirect("/taches");
  } catch (error) {
    console.error("Erreur lors de l'archivage de la tâche :", error);
    req.session.error_msg = "Une erreur est survenue lors de l'archivage.";
    res.redirect("/taches");
  }
});

// POST /taches/:id/unarchive - Restaurer une tâche des archives
router.post("/taches/:id/unarchive", requireAuth, async (req: any, res: any) => {
  try {
    const taskId = parseInt(req.params.id);
    await prisma.tache.update({
      where: { id: taskId },
      data: { archive: false },
    });

    await logActivity(
      req.session.userId,
      "RESTAURE_TACHE",
      "Tache",
      taskId
    );

    req.session.success_msg = "Tâche restaurée depuis les archives.";
    res.redirect("/taches/archives");
  } catch (error) {
    console.error("Erreur lors de la restauration de la tâche :", error);
    req.session.error_msg = "Une erreur est survenue lors de la restauration.";
    res.redirect("/taches/archives");
  }
});

// GET /taches/create - Formulaire de création d'une tâche
router.get("/taches/create", requireAuth, async (req: any, res: any) => {
  try {
    const [dossiers, agents] = await Promise.all([
      prisma.dossier.findMany({ orderBy: { numero: "asc" } }),
      prisma.user.findMany({ where: { actif: true }, orderBy: { nom: "asc" } }),
    ]);

    res.render("taches/create", {
      dossiers,
      agents,
      title: "Nouvelle Tâche de Transit",
    });
  } catch (error) {
    console.error("Erreur init formulaire tâche :", error);
    res.status(500).send("Erreur d'initialisation du formulaire.");
  }
});

// POST /taches/create - Traitement de la création d'une tâche
router.post("/taches/create", requireAuth, async (req: any, res: any) => {
  try {
    const { dossier_id, titre, intervenant_id, observations } = req.body;

    if (!dossier_id || !titre) {
      req.session.error_msg = "Veuillez remplir tous les champs obligatoires (*).";
      return res.redirect("/taches/create");
    }

    const dossierIdParsed = parseInt(dossier_id);
    const intervenantIdParsed = intervenant_id ? parseInt(intervenant_id) : null;

    const newTache = await prisma.tache.create({
      data: {
        dossier_id: dossierIdParsed,
        titre: titre.trim(),
        intervenant_id: intervenantIdParsed,
        etat: "EN_COURS",
        observations: observations ? observations.trim() : "",
        created_at: new Date(),
      },
    });

    await logActivity(
      req.session.userId,
      "CREATION_TACHE",
      "Tache",
      newTache.id
    );

    req.session.success_msg = `Tâche "${titre}" ajoutée avec succès !`;
    res.redirect("/taches");
  } catch (error) {
    console.error("Erreur lors de la création de la tâche :", error);
    req.session.error_msg = "Une erreur est survenue lors de l'enregistrement de la tâche.";
    res.redirect("/taches/create");
  }
});

// PATCH /taches/:id/status - Mise à jour du statut en temps réel (via drag and drop)
router.patch("/taches/:id/status", requireAuth, async (req: any, res: any) => {
  try {
    const taskId = parseInt(req.params.id);
    const { etat } = req.body;

    if (!etat) {
      return res.status(400).json({ success: false, message: "Le statut de remplacement est requis." });
    }

    // Vérifier l'existence
    const task = await prisma.tache.findUnique({ where: { id: taskId } });
    if (!task) {
      return res.status(404).json({ success: false, message: "Tâche introuvable." });
    }

    const userObject = req.session.user;
    const isSuperAdmin = userObject.role === "super_admin";
    const isIntervenant = task.intervenant_id === userObject.id;

    if (!isSuperAdmin && !isIntervenant) {
      return res.status(403).json({
        success: false,
        message: "Sécurité : Seul l'intervenant en charge de cette tâche (ou le Super Administrateur) peut modifier son état."
      });
    }

    const updatedTask = await prisma.tache.update({
      where: { id: taskId },
      data: { etat: etat },
    });

    await prisma.activityLog.create({
      data: {
        user_id: req.session.userId,
        action: 'tache.status',
        entity: 'dossier',
        entity_id: String(task.dossier_id),
        meta: JSON.stringify({
          titre: task.titre,
          from: task.etat,
          to: updatedTask.etat
        })
      }
    });

    await logActivity(
      req.session.userId,
      `T_STATUS_MOD_TO_${etat}`,
      "Tache",
      taskId
    );

    res.json({ success: true, taskId: updatedTask.id, etat: updatedTask.etat });
  } catch (error) {
    console.error("Erreur lors de la modification de statut de la tâche :", error);
    res.status(500).json({ success: false, message: "Erreur interne du serveur lors de la mise à jour." });
  }
});

// GET /taches/mine - Liste des tâches assignées à l'utilisateur connecté
router.get("/taches/mine", requireAuth, async (req: any, res: any) => {
  try {
    const list = await prisma.tache.findMany({
      where: {
        intervenant_id: req.session.userId,
        archive: false,
      },
      include: {
        dossier: true,
        subtasks: {
          orderBy: {
            created_at: "asc",
          },
        },
      },
      orderBy: {
        created_at: "desc",
      },
    });

    res.render("taches/mine", {
      taches: list,
      title: "Mes Tâches Assignées",
    });
  } catch (error) {
    console.error("Erreur récup mes tâches :", error);
    res.status(500).send("Erreur lors de la récupération de vos tâches.");
  }
});

// POST /taches/:id/subtasks - Ajouter une sous-tâche
router.post("/taches/:id/subtasks", requireAuth, async (req: any, res: any) => {
  try {
    const taskId = parseInt(req.params.id);
    const { titre } = req.body;

    if (!titre || !titre.trim()) {
      return res.status(400).json({ success: false, message: "Le titre de la sous-tâche est requis." });
    }

    const parentTache = await prisma.tache.findUnique({ where: { id: taskId } });
    if (!parentTache) {
      return res.status(404).json({ success: false, message: "Tâche parente introuvable." });
    }

    const userObject = req.session.user;
    if (userObject.role !== "super_admin" && parentTache.intervenant_id !== userObject.id) {
      return res.status(403).json({ success: false, message: "Action non autorisée. Seul l'intervenant en charge de cette tâche peut ajouter des sous-étapes." });
    }

    const sub = await prisma.subTask.create({
      data: {
        tache_id: taskId,
        titre: titre.trim(),
        fait: false,
      },
    });

    await logActivity(
      req.session.userId,
      "AJOUT_SOUS_TACHE",
      "SubTask",
      sub.id
    );

    res.json({ success: true, subtask: sub });
  } catch (error) {
    console.error("Erreur lors de l'ajout de la sous-tâche :", error);
    res.status(500).json({ success: false, message: "Erreur lors de la création de la sous-tâche." });
  }
});

// POST /subtasks/:id/toggle - Cocher/Décocher une sous-tâche
router.post("/subtasks/:id/toggle", requireAuth, async (req: any, res: any) => {
  try {
    const subtaskId = parseInt(req.params.id);
    const sub = await prisma.subTask.findUnique({
      where: { id: subtaskId },
      include: { tache: true }
    });

    if (!sub) {
      return res.status(404).json({ success: false, message: "Sous-tâche introuvable." });
    }

    const userObject = req.session.user;
    if (userObject.role !== "super_admin" && sub.tache.intervenant_id !== userObject.id) {
      return res.status(403).json({ success: false, message: "Action non autorisée. Seul l'intervenant en charge de cette tâche peut cocher les sous-étapes." });
    }

    const updated = await prisma.subTask.update({
      where: { id: subtaskId },
      data: { fait: !sub.fait },
    });

    await logActivity(
      req.session.userId,
      `TOGGLE_SOUS_TACHE_${updated.fait ? 'FAIT' : 'A_FAIRE'}`,
      "SubTask",
      subtaskId
    );

    res.json({ success: true, subtask: updated });
  } catch (error) {
    console.error("Erreur lors du basculement de la sous-tâche :", error);
    res.status(500).json({ success: false, message: "Erreur lors du traitement." });
  }
});

// POST /subtasks/:id/delete - Supprimer une sous-tâche
router.post("/subtasks/:id/delete", requireAuth, async (req: any, res: any) => {
  try {
    const subtaskId = parseInt(req.params.id);
    const sub = await prisma.subTask.findUnique({
      where: { id: subtaskId },
      include: { tache: true }
    });

    if (!sub) {
      return res.status(404).json({ success: false, message: "Sous-tâche introuvable." });
    }

    const userObject = req.session.user;
    if (userObject.role !== "super_admin" && sub.tache.intervenant_id !== userObject.id) {
      return res.status(403).json({ success: false, message: "Action non autorisée. Seul l'intervenant en charge de cette tâche peut supprimer des sous-étapes." });
    }

    await prisma.subTask.delete({
      where: { id: subtaskId },
    });

    await logActivity(
      req.session.userId,
      "SUPPRESSION_SOUS_TACHE",
      "SubTask",
      subtaskId
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Erreur lors de la suppression de la sous-tâche :", error);
    res.status(500).json({ success: false, message: "Erreur de suppression." });
  }
});

// GET /taches/:id - Fiche détaillée de la tâche avec la conversation
router.get("/taches/:id", requireAuth, async (req: any, res: any) => {
  try {
    const taskId = parseInt(req.params.id);
    const tache = await prisma.tache.findUnique({
      where: { id: taskId },
      include: {
        dossier: true,
        intervenant: true,
        subtasks: {
          orderBy: {
            created_at: "asc",
          },
        },
        comments: {
          include: {
            user: true,
          },
          orderBy: {
            created_at: "desc", // Latest comments first
          },
        },
      },
    });

    if (!tache) {
      req.session.error_msg = "Tâche introuvable.";
      return res.redirect("/taches");
    }

    const user = req.session.user;
    const isSuperAdmin = user.role === "super_admin";
    const isIntervenant = tache.intervenant_id === user.id;
    const isManagement = ["pdg", "dg", "dga", "daf", "auditeur1", "auditeur2"].includes(user.role);

    if (!isSuperAdmin && !isIntervenant && !isManagement) {
      req.session.error_msg = "Accès non autorisé : seul l'intervenant en charge ou la Direction peut ouvrir ce dossier de discussion.";
      return res.redirect(`/dossiers/${tache.dossier_id}`);
    }

    const allUsers = await prisma.user.findMany({
      where: { actif: true },
      select: {
        id: true,
        nom: true,
        email: true,
        role: true,
      },
      orderBy: {
        nom: "asc",
      },
    });

    res.render("taches/detail", {
      tache,
      allUsers,
      title: `Suivi Tâche : ${tache.titre}`,
    });
  } catch (error) {
    console.error("Erreur récup détail de la tâche :", error);
    res.status(500).send("Erreur de récupération.");
  }
});

// POST /taches/:id/comments → insert comment, return JSON
router.post("/taches/:id/comments", requireAuth, async (req: any, res: any) => {
  try {
    const taskId = parseInt(req.params.id);
    const { contenu, is_next_step } = req.body;
    const userId = req.session.userId;
    const userObject = req.session.user;

    const taskObj = await prisma.tache.findUnique({ where: { id: taskId } });
    if (!taskObj) {
      return res.status(404).json({ success: false, message: "Tâche introuvable." });
    }

    if (userObject.role !== "super_admin" && taskObj.intervenant_id !== userObject.id) {
      return res.status(403).json({ success: false, message: "Action non autorisée : seul l'intervenant en charge de cette étape peut soumettre des commentaires ou des rapports." });
    }

    if (!contenu || !contenu.trim()) {
      return res.status(400).json({ success: false, message: "Le commentaire ne peut pas être vide." });
    }

    const isNextStepBool = (is_next_step === true || is_next_step === "true" || is_next_step === "on");

    // Si c'est marqué comme prochaine étape, décocher toutes les anciennes prochaines étapes de cette tâche
    if (isNextStepBool) {
      await prisma.tacheComment.updateMany({
        where: { tache_id: taskId },
        data: { is_next_step: false },
      });
    }

    const comment = await prisma.tacheComment.create({
      data: {
        tache_id: taskId,
        user_id: userId,
        contenu: contenu.trim(),
        is_next_step: isNextStepBool,
      },
      include: {
        user: true,
      },
    });

    if (taskObj.dossier_id) {
      await prisma.activityLog.create({
        data: {
          user_id: userId,
          action: 'comment.added',
          entity: 'dossier',
          entity_id: String(taskObj.dossier_id),
          meta: JSON.stringify({
            preview: contenu.trim().slice(0, 60),
            task_titre: taskObj.titre
          })
        }
      });
    }

    await logActivity(
      userId,
      "AJOUT_COMMENTAIRE_TACHE",
      "TacheComment",
      comment.id
    );

    res.json({
      id: comment.id,
      contenu: comment.contenu,
      user_nom: comment.user.nom,
      created_at: comment.created_at,
      is_next_step: comment.is_next_step,
    });
  } catch (error) {
    console.error("Erreur création commentaire :", error);
    res.status(500).json({ success: false, message: "Erreur lors de la publication." });
  }
});

// DELETE /taches/:id/comments/:cid → only if session.user.id === comment.user_id or role=admin
router.delete("/taches/:id/comments/:cid", requireAuth, async (req: any, res: any) => {
  try {
    const commentId = parseInt(req.params.cid);
    const comment = await prisma.tacheComment.findUnique({
      where: { id: commentId },
    });

    if (!comment) {
      return res.status(404).json({ success: false, message: "Commentaire introuvable." });
    }

    const currentUserRole = res.locals.user?.role || "";
    if (comment.user_id !== req.session.userId && currentUserRole !== "ADMIN") {
      return res.status(403).json({ success: false, message: "Vous n'êtes pas autorisé à supprimer ce commentaire." });
    }

    await prisma.tacheComment.delete({
      where: { id: commentId },
    });

    await logActivity(
      req.session.userId,
      "SUPPRESSION_COMMENTAIRE_TACHE",
      "TacheComment",
      commentId
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Erreur suppression commentaire :", error);
    res.status(500).json({ success: false, message: "Erreur de suppression." });
  }
});

// PATCH /taches/:id/comments/:cid/pin → set this comment is_next_step=true, set all others false
router.patch("/taches/:id/comments/:cid/pin", requireAuth, async (req: any, res: any) => {
  try {
    const taskId = parseInt(req.params.id);
    const commentId = parseInt(req.params.cid);

    const comment = await prisma.tacheComment.findUnique({
      where: { id: commentId },
    });

    if (!comment || comment.tache_id !== taskId) {
      return res.status(404).json({ success: false, message: "Commentaire introuvable pour cette tâche." });
    }

    await prisma.tacheComment.updateMany({
      where: { tache_id: taskId },
      data: { is_next_step: false },
    });

    await prisma.tacheComment.update({
      where: { id: commentId },
      data: { is_next_step: true },
    });

    await logActivity(
      req.session.userId,
      "BL_PIN_PROCHAINE_ETAPE",
      "TacheComment",
      commentId
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Erreur épinglage commentaire :", error);
    res.status(500).json({ success: false, message: "Erreur d'épinglage." });
  }
});

export default router;
