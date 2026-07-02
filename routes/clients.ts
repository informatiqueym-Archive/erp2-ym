import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import prisma from "../lib/prismaClient";
import { requireAuth, requireModule } from "./rbac";
import { generateRef } from "../lib/generateRef";

const router = Router();

// Setup Multer for client documents
const uploadTempDir = path.join(process.cwd(), "uploads", "clients", "temp");
if (!fs.existsSync(uploadTempDir)) {
  fs.mkdirSync(uploadTempDir, { recursive: true });
}

const clientStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadTempDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const cleanedName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${uniqueSuffix}-${cleanedName}`);
  }
});

const clientUpload = multer({
  storage: clientStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req: any, file: any, cb: any) => {
    const filetypes = /pdf|jpg|jpeg|png/i;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Seuls les formats PDF, JPG, JPEG et PNG sont acceptés !"));
  }
});

// Helper for activity logs
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
    console.error("Erreur log clients route :", error);
  }
}

// GET /clients - List all clients
router.get("/clients", requireAuth, requireModule("clients"), async (req: any, res: any) => {
  try {
    const clientsList = await prisma.client.findMany({
      include: {
        _count: { select: { dossiers: true } },
      },
      orderBy: { nom: "asc" },
    });
    res.render("clients/index", { clients: clientsList });
  } catch (error) {
    console.error("Erreur list clients:", error);
    res.status(500).send("Erreur lors du chargement des clients.");
  }
});

// GET /clients/create - Render create form
router.get("/clients/create", requireAuth, requireModule("clients"), async (req: any, res: any) => {
  try {
    const auto_ref = generateRef("CLI");
    res.render("clients/create", { auto_ref });
  } catch (error) {
    console.error("Erreur GET /clients/create :", error);
    res.status(500).send("Erreur lors de l'affichage du formulaire.");
  }
});

// POST /clients/create - Create client with multi-file uploads
router.post(
  "/clients/create",
  requireAuth,
  requireModule("clients"),
  clientUpload.fields([
    { name: "fichier_cni", maxCount: 1 },
    { name: "fichier_procu", maxCount: 1 },
    { name: "fichier_rc", maxCount: 1 }
  ]),
  async (req: any, res: any) => {
    try {
      const { nom, representant, ref_interne, statut_initial, niu, rccm, adresse, tel, email, acf } = req.body;
      if (!nom) {
        req.session.error_msg = "La raison sociale du client est obligatoire.";
        return res.redirect("/clients/create");
      }

      // Check if representant is provided when required (we'll mark as required in UI)
      if (!representant) {
        req.session.error_msg = "Le nom du représentant est obligatoire.";
        return res.redirect("/clients/create");
      }

      const newClient = await prisma.client.create({
        data: {
          nom,
          representant,
          ref_interne: ref_interne || null,
          statut_initial: statut_initial || "IMPORTATEUR",
          niu: niu || null,
          rccm: rccm || null,
          adresse: adresse || null,
          tel: tel || null,
          email: email || null,
          acf: acf || null,
          societe: res.locals.user?.societe || "YM-TRANSIT Transit & Logistics Ltd",
        }
      });

      const clientDir = path.join(process.cwd(), "uploads", "clients", String(newClient.id));
      if (!fs.existsSync(clientDir)) {
        fs.mkdirSync(clientDir, { recursive: true });
      }

      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const fileMapping = [
        { field: "fichier_cni", category: "CNI" },
        { field: "fichier_procu", category: "PROCU" },
        { field: "fichier_rc", category: "RC" }
      ];

      for (const mapping of fileMapping) {
        const fileArr = files?.[mapping.field];
        if (fileArr && fileArr.length > 0) {
          const file = fileArr[0];
          const destPath = path.join(clientDir, file.filename);
          
          // Move file
          fs.renameSync(file.path, destPath);

          // Create document record
          await prisma.clientDocument.create({
            data: {
              client_id: newClient.id,
              user_id: req.session.userId,
              filename: file.filename,
              original: file.originalname,
              category: mapping.category,
              path: `/uploads/clients/${newClient.id}/${file.filename}`,
              comment: `Fichier ${mapping.category} de ${nom}`
            }
          });
        }
      }

      await logActivity(req.session.userId, "CREATION_CLIENT", "Client", newClient.id);
      req.session.success_msg = `✅ Client ${nom} créé. Vous pouvez maintenant créer son dossier.`;
      res.redirect(`/clients/${newClient.id}`);
    } catch (error: any) {
      console.error("Erreur POST /clients/create :", error);
      req.session.error_msg = "Erreur de création de l'importateur: " + (error.message || error);
      res.redirect("/clients/create");
    }
  }
);

// GET /clients/:id - Client details with documents
router.get("/clients/:id", requireAuth, requireModule(["clients", "dossiers"]), async (req: any, res: any) => {
  try {
    const clId = parseInt(req.params.id);
    if (isNaN(clId)) {
      req.session.error_msg = "Identifiant de client invalide.";
      return res.redirect("/clients");
    }

    const client = await prisma.client.findUnique({
      where: { id: clId },
      include: {
        client_documents: {
          include: { user: true },
          orderBy: { created_at: "asc" }
        },
        representants: true,
        _count: { select: { dossiers: true } }
      }
    });

    if (!client) {
      req.session.error_msg = "Client introuvable.";
      return res.redirect("/clients");
    }

    res.render("clients/detail", { client_obj: client });
  } catch (error) {
    console.error("Erreur detail client :", error);
    res.status(500).send("Erreur lors de la récupération des informations du client.");
  }
});

// POST /clients/new - Existing simple create (for compatibility)
router.post("/clients/new", requireAuth, requireModule("clients"), async (req: any, res: any) => {
  try {
    const { nom, niu, rccm, tel, adresse } = req.body;
    if (!nom) {
      req.session.error_msg = "La raison sociale du client est obligatoire.";
      return res.redirect("/clients");
    }

    const auto_ref = generateRef("CLI");

    const newClient = await prisma.client.create({
      data: {
        nom,
        niu: niu || null,
        rccm: rccm || null,
        tel: tel || null,
        adresse: adresse || null,
        ref_interne: auto_ref,
        societe: res.locals.user?.societe || "YM-TRANSIT Transit & Logistics Ltd",
      },
    });

    await logActivity(req.session.userId, "CREATION_CLIENT", "Client", newClient.id);
    req.session.success_msg = "Client créé avec succès !";
    res.redirect("/clients");
  } catch (error: any) {
    console.error(error);
    req.session.error_msg = "Erreur de création: " + error.message;
    res.redirect("/clients");
  }
});

// POST /api/clients/quick - AJAX fast client creation
router.post("/api/clients/quick", requireAuth, requireModule("clients"), async (req: any, res: any) => {
  try {
    const { nom, niu, rccm, tel, adresse } = req.body;
    if (!nom) {
      return res.status(400).json({ success: false, error: "La raison sociale du client est obligatoire." });
    }

    const auto_ref = generateRef("CLI");

    const newClient = await prisma.client.create({
      data: {
        nom,
        niu: niu || null,
        rccm: rccm || null,
        tel: tel || null,
        adresse: adresse || null,
        ref_interne: auto_ref,
        societe: res.locals.user?.societe || "YM-TRANSIT Transit & Logistics Ltd",
      },
    });

    await logActivity(req.session.userId, "CREATION_CLIENT_RAPIDE", "Client", newClient.id);
    return res.json({ success: true, client: newClient });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ success: false, error: "Erreur lors de la création du client: " + error.message });
  }
});

// POST /clients/update/:id
router.post("/clients/update/:id", requireAuth, requireModule("clients"), async (req: any, res: any) => {
  try {
    const clId = parseInt(req.params.id);
    const { nom, niu, rccm, tel, adresse, representant, statut_initial, acf, email } = req.body;

    await prisma.client.update({
      where: { id: clId },
      data: {
        nom,
        niu: niu || null,
        rccm: rccm || null,
        tel: tel || null,
        adresse: adresse || null,
        representant: representant || null,
        statut_initial: statut_initial || "IMPORTATEUR",
        acf: acf || null,
        email: email || null
      },
    });

    await logActivity(req.session.userId, "EDITION_CLIENT", "Client", clId);
    req.session.success_msg = "Coordonnées de l'importateur mises à jour.";
    res.redirect("/clients");
  } catch (error) {
    console.error(error);
    req.session.error_msg = "Erreur de modification du client.";
    res.redirect("/clients");
  }
});

// POST /clients/delete/:id
router.post("/clients/delete/:id", requireAuth, requireModule("clients"), async (req: any, res: any) => {
  try {
    const clId = parseInt(req.params.id);
    const client = await prisma.client.findUnique({ where: { id: clId } });
    if (!client) {
      req.session.error_msg = "Client introuvable.";
      return res.redirect("/clients");
    }

    await prisma.client.delete({ where: { id: clId } });
    await logActivity(req.session.userId, "SUPPRESSION_CLIENT", "Client", clId);
    req.session.success_msg = `Client "${client.nom}" et toutes les données associées ont été supprimés.`;
    res.redirect("/clients");
  } catch (error) {
    console.error(error);
    req.session.error_msg = "Erreur de suppression de l'importateur.";
    res.redirect("/clients");
  }
});

// GET /clients/:id/representants - List of representatives for a client
router.get("/clients/:id/representants", requireAuth, requireModule(["clients", "dossiers"]), async (req: any, res: any) => {
  try {
    const clId = parseInt(req.params.id);
    if (isNaN(clId)) {
      req.session.error_msg = "Identifiant de client invalide.";
      return res.redirect("/clients");
    }

    const client = await prisma.client.findUnique({
      where: { id: clId },
      include: { representants: true }
    });

    if (!client) {
      req.session.error_msg = "Client introuvable.";
      return res.redirect("/clients");
    }

    res.render("clients/representants", { client_obj: client });
  } catch (error: any) {
    console.error("Erreur list représentants:", error);
    res.status(500).send("Erreur lors de la récupération des représentants.");
  }
});

// GET /clients/:id/representants/create - Form to create a representative
router.get("/clients/:id/representants/create", requireAuth, requireModule(["clients", "dossiers"]), async (req: any, res: any) => {
  try {
    const clId = parseInt(req.params.id);
    if (isNaN(clId)) {
      req.session.error_msg = "Identifiant de client invalide.";
      return res.redirect("/clients");
    }

    const client = await prisma.client.findUnique({ where: { id: clId } });

    if (!client) {
      req.session.error_msg = "Client introuvable.";
      return res.redirect("/clients");
    }

    res.render("clients/representants/create", { client_obj: client });
  } catch (error: any) {
    console.error("Erreur GET /clients/:id/representants/create:", error);
    res.status(500).send("Erreur de chargement du formulaire.");
  }
});

// POST /clients/:id/representants/create - Create representative with documents
router.post(
  "/clients/:id/representants/create",
  requireAuth,
  requireModule(["clients", "dossiers"]),
  clientUpload.fields([
    { name: "fichier_cni", maxCount: 1 },
    { name: "fichier_procuration", maxCount: 1 }
  ]),
  async (req: any, res: any) => {
    try {
      const clId = parseInt(req.params.id);
      if (isNaN(clId)) {
        req.session.error_msg = "Identifiant de client invalide.";
        return res.redirect("/clients");
      }

      const { nom, prenom, tel, email, cni_numero, fonction } = req.body;

      if (!nom) {
        req.session.error_msg = "Le nom du représentant est obligatoire.";
        return res.redirect(`/clients/${clId}/representants/create`);
      }

      // 1. Create the representant
      const representant = await prisma.representant.create({
        data: {
          client_id: clId,
          nom,
          prenom: prenom || null,
          tel: tel || null,
          email: email || null,
          cni_numero: cni_numero || null,
          fonction: fonction || null,
          actif: true
        }
      });

      // 2. Handle files
      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
      const clientDir = path.join(process.cwd(), "uploads", "clients", String(clId));
      if (!fs.existsSync(clientDir)) {
        fs.mkdirSync(clientDir, { recursive: true });
      }

      if (files) {
        if (files["fichier_cni"] && files["fichier_cni"][0]) {
          const file = files["fichier_cni"][0];
          const destPath = path.join(clientDir, file.filename);
          fs.renameSync(file.path, destPath);

          await prisma.clientDocument.create({
            data: {
              client_id: clId,
              user_id: req.session.userId,
              filename: file.filename,
              original: file.originalname,
              category: "CNI",
              path: `/uploads/clients/${clId}/${file.filename}`,
              comment: `CNI du représentant ${nom} ${prenom || ""}`.trim(),
              representant_id: representant.id
            }
          });
        }

        if (files["fichier_procuration"] && files["fichier_procuration"][0]) {
          const file = files["fichier_procuration"][0];
          const destPath = path.join(clientDir, file.filename);
          fs.renameSync(file.path, destPath);

          await prisma.clientDocument.create({
            data: {
              client_id: clId,
              user_id: req.session.userId,
              filename: file.filename,
              original: file.originalname,
              category: "PROCU",
              path: `/uploads/clients/${clId}/${file.filename}`,
              comment: `Procuration du représentant ${nom} ${prenom || ""}`.trim(),
              representant_id: representant.id
            }
          });
        }
      }

      await logActivity(req.session.userId, "CREATION_REPRESENTANT", "Representant", representant.id);
      req.session.success_msg = `✅ Représentant ${nom} ${prenom || ""} ajouté avec succès.`;
      res.redirect(`/clients/${clId}`);
    } catch (error: any) {
      console.error("Erreur création représentant:", error);
      req.session.error_msg = "Erreur de création du représentant: " + (error.message || error);
      res.redirect(`/clients/${req.params.id}/representants/create`);
    }
  }
);

// GET /api/clients/:id/representants - JSON list of representatives
router.get("/api/clients/:id/representants", requireAuth, async (req: any, res: any) => {
  try {
    const clId = parseInt(req.params.id);
    if (isNaN(clId)) {
      return res.status(400).json({ error: "Identifiant de client invalide." });
    }

    const representants = await prisma.representant.findMany({
      where: { client_id: clId },
      include: {
        documents: true
      }
    });

    const mapped = representants.map(r => {
      const has_cni = r.documents.some(d => d.category === "CNI");
      const has_procu = r.documents.some(d => d.category === "PROCU");
      return {
        id: r.id,
        nom: r.nom,
        prenom: r.prenom || "",
        tel: r.tel || "",
        email: r.email || "",
        cni_numero: r.cni_numero || "",
        fonction: r.fonction || "",
        actif: r.actif,
        has_cni,
        has_procu
      };
    });

    res.json(mapped);
  } catch (error: any) {
    console.error("Erreur API list représentants:", error);
    res.status(500).json({ error: "Erreur serveur: " + error.message });
  }
});

// PATCH /clients/:id/representants/:repId/toggle - Toggle representant activity
router.patch("/clients/:id/representants/:repId/toggle", requireAuth, requireModule(["clients", "dossiers"]), async (req: any, res: any) => {
  try {
    const repId = parseInt(req.params.repId);
    if (isNaN(repId)) {
      return res.status(400).json({ success: false, error: "Identifiant de représentant invalide." });
    }

    const representant = await prisma.representant.findUnique({
      where: { id: repId }
    });

    if (!representant) {
      return res.status(404).json({ success: false, error: "Représentant introuvable" });
    }

    const updated = await prisma.representant.update({
      where: { id: repId },
      data: { actif: !representant.actif }
    });

    await logActivity(req.session.userId, "TOGGLE_REPRESENTANT", "Representant", repId);
    res.json({ success: true, actif: updated.actif });
  } catch (error: any) {
    console.error("Erreur toggle représentant:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
