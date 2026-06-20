import { PrismaClient } from "@prisma/client";
import bcryptjs from "bcryptjs";

const prisma = new PrismaClient();
const SOCIETE = "YM-TRANSIT Transit & Logistics Ltd";

async function main() {
  const userCount = await prisma.user.count().catch(() => 0);
  if (userCount > 0) {
    console.log(`✅ [SEED] Base déjà peuplée (${userCount} utilisateurs). Seed ignoré.`);
    return;
  }

  console.log("🌱 [SEED] Début du peuplement...");

  const users = [
    // ── SUPER ADMIN ──
    { nom: "Yannick Abega", prenom: "Super Admin", email: "admin@ym-transit.cm", password: "admin123", role: "super_admin" },
    // ── ADMINISTRATION ──
    { nom: "Paul Biya", prenom: "Président", email: "pdg@ym-transit.cm", password: "pdg123", role: "pdg" },
    { nom: "Jean Fochive", prenom: "Directeur Général", email: "dg@ym-transit.cm", password: "dg123", role: "dg" },
    { nom: "Marie Ekani", prenom: "DGA", email: "dga@ym-transit.cm", password: "dga123", role: "dga" },
    { nom: "Pierre Messi", prenom: "DAF", email: "daf@ym-transit.cm", password: "daf123", role: "daf" },
    { nom: "Alice Mbarga", prenom: "Auditeur 1", email: "auditeur1@ym-transit.cm", password: "audit123", role: "auditeur1" },
    { nom: "Robert Nkodo", prenom: "Auditeur 2", email: "auditeur2@ym-transit.cm", password: "audit2123", role: "auditeur2" },
    // ── TRANSIT — Secrétariat ──
    { nom: "Marie Secretaire", prenom: "Secrétariat", email: "secretariat@ym-transit.cm", password: "secret123", role: "secretariat" },
    // ── TRANSIT — GUCE ──
    { nom: "Bernard GUCE", prenom: "Agent GUCE", email: "guce@ym-transit.cm", password: "guce123", role: "guce" },
    // ── TRANSIT — Validation ──
    { nom: "Jean Validateur", prenom: "Validation CAMCIS", email: "validation@ym-transit.cm", password: "valid123", role: "validation_role" },
    // ── TRANSIT — Gestion des Bours ──
    { nom: "Marc Acconage", prenom: "Service Acconage", email: "acconage@ym-transit.cm", password: "accon123", role: "acconage" },
    { nom: "Awa Enlevement", prenom: "Enlèvement Livraison", email: "enlevement@ym-transit.cm", password: "enlev123", role: "enlevement" },
    // ── FINANCE ──
    { nom: "Nadege Facturation", prenom: "Facturation", email: "facturation@ym-transit.cm", password: "fact123", role: "finances" },
    { nom: "Samuel Fiscalite", prenom: "Fiscalité", email: "fiscalite@ym-transit.cm", password: "fisc123", role: "fiscalite" },
    { nom: "Roger Cloture", prenom: "Clôture", email: "cloture@ym-transit.cm", password: "clot123", role: "cloture" },
    // ── COMPTABILITÉ ──
    { nom: "Claire Caisse", prenom: "Agent Caisse", email: "caisse@ym-transit.cm", password: "caisse123", role: "caisse" },
    // ── ANALYSE ──
    { nom: "Sophie Analyste", prenom: "Analyste", email: "analyste@ym-transit.cm", password: "analyse123", role: "analyste" },
    // ── ARCHIVES ──
    { nom: "Eric Archives", prenom: "Archiviste", email: "archives@ym-transit.cm", password: "archives123", role: "archiviste" },
  ];

  console.log(`[SEED] Création de ${users.length} utilisateurs...`);
  const created: any[] = [];
  for (const u of users) {
    const hash = await bcryptjs.hash(u.password, 10);
    const user = await prisma.user.create({
      data: { nom: u.nom, prenom: u.prenom, email: u.email, password: hash, role: u.role, societe: SOCIETE, actif: true, force_pwd_change: false }
    });
    created.push(user);
    console.log(`  ✅ ${u.email} (${u.role})`);
  }

  const admin = created[0];
  const secretariat = created.find(u => u.role === "secretariat")!;

  // Clients
  const client1 = await prisma.client.create({ data: { nom: "Société Anonyme des Brasseries du Cameroun (SABC)", niu: "M012345678912A", rccm: "RC/DLA/2014/B/1023", adresse: "Rue de la Marine, Douala, Cameroun", tel: "+237 233 45 67 89", societe: SOCIETE } });
  const client2 = await prisma.client.create({ data: { nom: "Sodecoton S.A.", niu: "M118931234056X", rccm: "RC/YDE/1998/B/456", adresse: "Quartier Commercial, Garoua, Cameroun", tel: "+237 222 27 11 22", societe: SOCIETE } });
  const client3 = await prisma.client.create({ data: { nom: "Cicam S.A.", niu: "M098711445588G", rccm: "RC/DLA/2005/B/991", adresse: "Zone Industrielle Bassa, Douala", tel: "+237 233 42 11 50", societe: SOCIETE } });
  console.log("[SEED] ✅ Clients créés");

  // Dossiers — with new pipeline status GUCE added
  const dossier1 = await prisma.dossier.create({ data: { numero: "DOS-2026-0001", client_id: client1.id, port: "Port Autonome de Douala (PAD)", nature: "IMPORT", etat: "EN_COURS", bl: "MSCU12575456581", contenu: "Boissons et équipements brassicoles", droits_douane: 450000, valeur_douane: 12000000, representant: "M. Alain Brasseur", pipeline_status: "EN_TRAITEMENT", created_at: new Date("2026-05-10T10:00:00Z") } });
  const dossier2 = await prisma.dossier.create({ data: { numero: "DOS-2026-0002", client_id: client2.id, port: "Port de Kribi", nature: "EXPORT", etat: "OUVERT", bl: "HLCU897121344", contenu: "Coton et fibres textiles", droits_douane: 150000, valeur_douane: 5000000, representant: "Mme. Fatima Coton", pipeline_status: "GUCE", created_at: new Date("2026-06-01T14:30:00Z") } });
  const dossier3 = await prisma.dossier.create({ data: { numero: "DOS-2026-0003", client_id: client3.id, port: "Port Autonome de Douala (PAD)", nature: "IMPORT", etat: "OUVERT", bl: "CMDU334455667", contenu: "Fils et tissus industriels", droits_douane: 75000, valeur_douane: 3500000, representant: "M. Jacques Tisserand", pipeline_status: "CREE", created_at: new Date("2026-06-15T09:00:00Z") } });
  console.log("[SEED] ✅ Dossiers créés");

  // Taches
  const agent = created.find(u => u.role === "acconage")!;
  await prisma.tache.create({ data: { dossier_id: dossier1.id, titre: "Retrait du Bon à Délivrer (BAD) chez l'Armateur", intervenant_id: agent.id, etat: "FAIT", observations: "BAD récupéré auprès de MSC Douala.", deadline: new Date("2026-06-15T12:00:00Z") } });
  await prisma.tache.create({ data: { dossier_id: dossier1.id, titre: "Établissement du Document Unique de Douane (DUD)", intervenant_id: agent.id, etat: "EN_COURS", observations: "En attente de validation sur Sydonia.", deadline: new Date("2026-06-18T17:00:00Z") } });
  await prisma.tache.create({ data: { dossier_id: dossier2.id, titre: "Visite phytosanitaire à l'exportation", intervenant_id: agent.id, etat: "A_FAIRE", observations: "RDV avec inspecteur de Kribi à planifier.", deadline: new Date("2026-06-25T11:00:00Z") } });
  console.log("[SEED] ✅ Tâches créées");

  // Stock
  await prisma.stock.createMany({ data: [
    { nom: "Palettes Europe Bois Standard (1200x800)", quantite: 450, stock_min: 100, prix_vente: 8500, lieu_stockage: "Entrepôt Douala Port - Zone B" },
    { nom: "Sangles d'Amarrage Haute Résistance (5T)", quantite: 120, stock_min: 30, prix_vente: 15000, lieu_stockage: "Entrepôt Kribi - Box 4" },
    { nom: "Film Emballage Étirable (Rouleau 500m)", quantite: 15, stock_min: 20, prix_vente: 7500, lieu_stockage: "Magasin Douala - Bureau Transit" }
  ]});
  console.log("[SEED] ✅ Stocks créés");

  // Documents
  const doc1 = await prisma.document.create({ data: { type: "FACTURE", numero: "FAC-2026-0001", client_id: client1.id, societe: SOCIETE, total_ht: 1250000, total_ttc: 1490625, etat: "PAYE", created_at: new Date("2026-05-18T08:00:00Z") } });
  await prisma.invoiceLine.createMany({ data: [
    { document_id: doc1.id, description: "Prestations d'agrément en douane (Import SABC)", quantite: 1, prix_unitaire: 500000, taxe_id: "TVA_19_25", total: 500000 },
    { document_id: doc1.id, description: "Manutention portuaire et dépotage conteneur 40 pieds", quantite: 1, prix_unitaire: 450000, taxe_id: "TVA_19_25", total: 450000 },
    { document_id: doc1.id, description: "Frais de cautionnement douane et armateur", quantite: 1, prix_unitaire: 300000, taxe_id: "TVA_19_25", total: 300000 }
  ]});
  await prisma.payment.create({ data: { document_id: doc1.id, montant: 1490625, moyen: "VIREMENT", date_paiement: new Date("2026-05-20T14:00:00Z") } });
  console.log("[SEED] ✅ Documents créés");

  // Activity logs
  await prisma.activityLog.createMany({ data: [
    { user_id: admin.id, action: "CONNEXION", entity: "User", entity_id: String(admin.id), created_at: new Date("2026-06-12T07:05:00Z") },
    { user_id: secretariat.id, action: "OUVERTURE_DOSSIER", entity: "Dossier", entity_id: String(dossier3.id), created_at: new Date("2026-06-15T09:05:00Z") }
  ]});

  console.log("\n✅ [SEED] Peuplement terminé avec succès !");
  console.log("\n📋 Comptes de test créés :");
  console.log("   Administration: pdg@ym-transit.cm/pdg123 | dg@ym-transit.cm/dg123 | dga/dga123 | daf/daf123");
  console.log("   Auditeurs: auditeur1@ym-transit.cm/audit123 | auditeur2@ym-transit.cm/audit2123");
  console.log("   Transit: secretariat@ym-transit.cm/secret123 | guce@ym-transit.cm/guce123 | validation@ym-transit.cm/valid123");
  console.log("   Gestion Bours: acconage@ym-transit.cm/accon123 | enlevement@ym-transit.cm/enlev123");
  console.log("   Finance: facturation@ym-transit.cm/fact123 | fiscalite@ym-transit.cm/fisc123 | cloture@ym-transit.cm/clot123");
  console.log("   Comptabilité: caisse@ym-transit.cm/caisse123");
  console.log("   Analyse: analyste@ym-transit.cm/analyse123");
  console.log("   Archives: archives@ym-transit.cm/archives123");
  console.log("   Super Admin: admin@ym-transit.cm/admin123");
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
