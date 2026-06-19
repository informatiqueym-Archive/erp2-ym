import { PrismaClient } from "@prisma/client";
import bcryptjs from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const clientCount = await prisma.client.count().catch(() => 0);
  if (clientCount > 0) {
    console.log("La base de données contient déjà des données (clients). Cycle de peuplement ignoré.");
    return;
  }

  console.log("Début du peuplement de la base de données...");

  // Nettoyage de la base
  await prisma.activityLog.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.invoiceLine.deleteMany({});
  await prisma.document.deleteMany({});
  await prisma.tache.deleteMany({});
  await prisma.dossier.deleteMany({});
  await prisma.client.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.stock.deleteMany({});

  // 1. Création des utilisateurs
  const adminHash = await bcryptjs.hash("admin123", 10);
  const transitHash = await bcryptjs.hash("transit123", 10);
  const comptaHash = await bcryptjs.hash("compta123", 10);
  const acconageHash = await bcryptjs.hash("acconage123", 10);
  const enlevementHash = await bcryptjs.hash("enlevement123", 10);
  const directionHash = await bcryptjs.hash("direction123", 10);
  const caisseHash = await bcryptjs.hash("caisse123", 10);
  const financesHash = await bcryptjs.hash("finances123", 10);
  const comptaOpsHash = await bcryptjs.hash("comptaops123", 10);

  const admin = await prisma.user.create({
    data: {
      nom: "Yannick Abega",
      email: "admin@ym-transit.cm",
      password: adminHash,
      role: "super_admin",
      societe: "YM-TRANSIT Transit & Logistics Ltd",
      actif: true,
    },
  });

  const agent1 = await prisma.user.create({
    data: {
      nom: "Mamadou Bello",
      email: "transit@ym-transit.cm",
      password: transitHash,
      role: "operationnel",
      societe: "YM-TRANSIT Transit & Logistics Ltd",
      actif: true,
    },
  });

  const accountant = await prisma.user.create({
    data: {
      nom: "Claire Ngo Ntamack",
      email: "compta@ym-transit.cm",
      password: comptaHash,
      role: "comptable",
      societe: "YM-TRANSIT Transit & Logistics Ltd",
      actif: true,
    },
  });

  await prisma.user.create({
    data: {
      nom: "Service Acconage",
      email: "acconage@ym-transit.cm",
      password: acconageHash,
      role: "acconage",
      societe: "YM-TRANSIT Transit & Logistics Ltd",
      actif: true,
    },
  });

  await prisma.user.create({
    data: {
      nom: "Service Enlevement",
      email: "enlevement@ym-transit.cm",
      password: enlevementHash,
      role: "enlevement",
      societe: "YM-TRANSIT Transit & Logistics Ltd",
      actif: true,
    },
  });

  await prisma.user.create({
    data: {
      nom: "Directeur",
      email: "direction@ym-transit.cm",
      password: directionHash,
      role: "direction",
      societe: "YM-TRANSIT Transit & Logistics Ltd",
      actif: true,
    },
  });

  await prisma.user.create({
    data: {
      nom: "Agent Payeur",
      email: "caisse@ym-transit.cm",
      password: caisseHash,
      role: "agent_payeur",
      societe: "YM-TRANSIT Transit & Logistics Ltd",
      actif: true,
    },
  });

  await prisma.user.create({
    data: {
      nom: "Directeur Financier",
      email: "finances@ym-transit.cm",
      password: financesHash,
      role: "finances",
      societe: "YM-TRANSIT Transit & Logistics Ltd",
      actif: true,
    },
  });

  await prisma.user.create({
    data: {
      nom: "Comptable Operations",
      email: "compta_ops@ym-transit.cm",
      password: comptaOpsHash,
      role: "comptable_ops",
      societe: "YM-TRANSIT Transit & Logistics Ltd",
      actif: true,
    },
  });

  console.log("Utilisateurs insérés.");

  // 2. Création des clients
  const client1 = await prisma.client.create({
    data: {
      nom: "Société Anonyme des Brasseries du Cameroun (SABC)",
      niu: "M012345678912A",
      rccm: "RC/DLA/2014/B/1023",
      adresse: "Rue de la Marine, Douala, Cameroun",
      tel: "+237 233 45 67 89",
      societe: "YM-TRANSIT Transit & Logistics Ltd",
    },
  });

  const client2 = await prisma.client.create({
    data: {
      nom: "Sodecoton S.A.",
      niu: "M118931234056X",
      rccm: "RC/YDE/1998/B/456",
      adresse: "Quartier Commercial, Garoua, Cameroun",
      tel: "+237 222 27 11 22",
      societe: "YM-TRANSIT Transit & Logistics Ltd",
    },
  });

  const client3 = await prisma.client.create({
    data: {
      nom: "Cicam S.A.",
      niu: "M098711445588G",
      rccm: "RC/DLA/2005/B/991",
      adresse: "Zone Industrielle Bassa, Douala",
      tel: "+237 233 42 11 50",
      societe: "YM-TRANSIT Transit & Logistics Ltd",
    },
  });

  console.log("Clients insérés.");

  // 3. Création des Dossiers de Transit
  const dossier1 = await prisma.dossier.create({
    data: {
      numero: "DOS-2026-0001",
      client_id: client1.id,
      port: "Port Autonome de Douala (PAD)",
      nature: "IMPORT",
      etat: "EN_COURS",
      created_at: new Date("2026-05-10T10:00:00Z"),
      pipeline_status: "EN_TRAITEMENT",
    },
  });

  const dossier2 = await prisma.dossier.create({
    data: {
      numero: "DOS-2026-0002",
      client_id: client2.id,
      port: "Port de Kribi (Seaport)",
      nature: "EXPORT",
      etat: "OUVERT",
      created_at: new Date("2026-06-01T14:30:00Z"),
      pipeline_status: "CREE",
    },
  });

  const dossier3 = await prisma.dossier.create({
    data: {
      numero: "DOS-2026-0003",
      client_id: client3.id,
      port: "Port Autonome de Douala (PAD)",
      nature: "IMPORT",
      etat: "CLOTURE",
      created_at: new Date("2026-04-15T09:00:00Z"),
      pipeline_status: "ARCHIVE",
      archived_at: new Date("2026-06-15T10:00:00Z"),
    },
  });

  console.log("Dossiers insérés.");

  // 4. Création des Tâches
  await prisma.tache.create({
    data: {
      dossier_id: dossier1.id,
      titre: "Retrait du Bon à Délivrer (BAD) chez l'Armateur",
      intervenant_id: agent1.id,
      etat: "TERMINE",
      observations: "BAD récupéré auprès de MSC Douala après paiement des frais d'escale.",
      deadline: new Date("2026-06-15T12:00:00Z"),
    },
  });

  await prisma.tache.create({
    data: {
      dossier_id: dossier1.id,
      titre: "Établissement du Document Unique de Douane (DUD)",
      intervenant_id: agent1.id,
      etat: "EN_COURS",
      observations: "En attente de la validation finale du tarif douanier sur Sydonia.",
      deadline: new Date("2026-06-18T17:00:00Z"),
    },
  });

  await prisma.tache.create({
    data: {
      dossier_id: dossier2.id,
      titre: "Visite Phytosanitaire à l'exportation",
      intervenant_id: agent1.id,
      etat: "A_FAIRE",
      observations: "Prendre rendez-vous avec l'inspecteur phytosanitaire de Kribi.",
      deadline: new Date("2026-06-25T11:00:00Z"),
    },
  });

  console.log("Tâches insérées.");

  // 5. Création de Stocks (Consommables logistiques ou marchandises en entrepôt)
  const stock1 = await prisma.stock.create({
    data: {
      nom: "Palettes Europe en Bois Standard (1200x800)",
      quantite: 450,
      stock_min: 100,
      prix_vente: 8500, // FCFA
      lieu_stockage: "Entrepôt Douala Port - Zone B",
    },
  });

  const stock2 = await prisma.stock.create({
    data: {
      nom: "Sangles d'Amarrage Haute Résistance (5T)",
      quantite: 120,
      stock_min: 30,
      prix_vente: 15000, // FCFA
      lieu_stockage: "Entrepôt Kribi Port - Box 4",
    },
  });

  const stock3 = await prisma.stock.create({
    data: {
      nom: "Film d'Amballage Étirable (Rouleau 500m)",
      quantite: 15, // Alerte stock car inférieur au min !
      stock_min: 20,
      prix_vente: 7500, // FCFA
      lieu_stockage: "Magasin Douala - Bureau Transit",
    },
  });

  console.log("Stocks insérés.");

  // 6. Création de Documents (Factures/Devis) et lignes
  const doc1 = await prisma.document.create({
    data: {
      type: "FACTURE",
      numero: "FAC-2026-0001",
      client_id: client1.id,
      societe: "YM-TRANSIT Transit & Logistics Ltd",
      total_ht: 1250000,
      total_ttc: 1490625, // HT + 19.25% de taxe
      etat: "PAYE",
      created_at: new Date("2026-05-18T08:00:00Z"),
    },
  });

  await prisma.invoiceLine.createMany({
    data: [
      {
        document_id: doc1.id,
        description: "Prestations d'agréement en douane (Imp. SABC)",
        quantite: 1,
        prix_unitaire: 500000,
        taxe_id: "TVA_19_25",
        total: 500000,
      },
      {
        document_id: doc1.id,
        description: "Manutention portuaire, acconage et dépotage conteneur 40 pieds",
        quantite: 1,
        prix_unitaire: 450000,
        taxe_id: "TVA_19_25",
        total: 450000,
      },
      {
        document_id: doc1.id,
        description: "Frais de cautionnement douane et caution d'armateur",
        quantite: 1,
        prix_unitaire: 300000,
        taxe_id: "TVA_19_25",
        total: 300000,
      },
    ],
  });

  const doc2 = await prisma.document.create({
    data: {
      type: "FACTURE",
      numero: "FAC-2026-0002",
      client_id: client2.id,
      societe: "YM-TRANSIT Transit & Logistics Ltd",
      total_ht: 800000,
      total_ttc: 954000,
      etat: "EMIS",
      created_at: new Date("2026-06-03T11:00:00Z"),
    },
  });

  await prisma.invoiceLine.createMany({
    data: [
      {
        document_id: doc2.id,
        description: "Frais de dossier phytosanitaire export",
        quantite: 1,
        prix_unitaire: 200000,
        taxe_id: "TVA_19_25",
        total: 200000,
      },
      {
        document_id: doc2.id,
        description: "Chargement camion et logistique Garoua - Kribi Port",
        quantite: 1,
        prix_unitaire: 600000,
        taxe_id: "TVA_19_25",
        total: 600000,
      },
    ],
  });

  const doc3 = await prisma.document.create({
    data: {
      type: "DEVIS",
      numero: "DEV-2026-0001",
      client_id: client3.id,
      societe: "YM-TRANSIT Transit & Logistics Ltd",
      total_ht: 450000,
      total_ttc: 536625,
      etat: "BROUILLON",
      created_at: new Date("2026-06-10T15:30:00Z"),
    },
  });

  await prisma.invoiceLine.createMany({
    data: [
      {
        document_id: doc3.id,
        description: "Conseil juridique en formalités douanières d'importation",
        quantite: 1,
        prix_unitaire: 450000,
        taxe_id: "TVA_19_25",
        total: 450000,
      },
    ],
  });

  console.log("Documents comptables et lignes insérés.");

  // 7. Enregistrement des Paiements
  await prisma.payment.create({
    data: {
      document_id: doc1.id,
      montant: 1490625,
      moyen: "VIREMENT",
      date_paiement: new Date("2026-05-20T14:00:00Z"),
    },
  });

  await prisma.payment.create({
    data: {
      document_id: doc2.id,
      montant: 300000, // Paiement partiel
      moyen: "MOMO",
      date_paiement: new Date("2026-06-05T09:12:00Z"),
    },
  });

  console.log("Paiements enregistrés.");

  // 8. Traces d'activités
  await prisma.activityLog.create({
    data: {
      user_id: admin.id,
      action: "CONNEXION",
      entity: "User",
      entity_id: String(admin.id),
      created_at: new Date("2026-06-12T07:05:00Z"),
    },
  });

  await prisma.activityLog.create({
    data: {
      user_id: admin.id,
      action: "CREATION_DOSSIER",
      entity: "Dossier",
      entity_id: String(dossier2.id),
      created_at: new Date("2026-06-12T07:15:00Z"),
    },
  });

  await prisma.activityLog.create({
    data: {
      user_id: accountant.id,
      action: "EMISSION_FACTURE",
      entity: "Document",
      entity_id: String(doc2.id),
      created_at: new Date("2026-06-03T11:05:00Z"),
    },
  });

  console.log("Activités enregistrées.");
  console.log("Peuplement terminé avec succès !");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
