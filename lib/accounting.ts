import { PrismaClient } from "@prisma/client";

export async function postEcriture(
  prisma: any,
  {
    journal,
    piece_ref,
    libelle,
    societe,
    created_by,
    date,
    lignes
  }: {
    journal: string;
    piece_ref: string;
    libelle: string;
    societe: string;
    created_by: number;
    date: Date | string;
    lignes: Array<{ compte_id: number; debit: number; credit: number }>;
  }
) {
  const total_debit = lignes.reduce((s, l) => s + (l.debit || 0), 0);
  const total_credit = lignes.reduce((s, l) => s + (l.credit || 0), 0);
  if (Math.abs(total_debit - total_credit) > 0.01) {
    throw new Error('Écriture déséquilibrée: débit ' + total_debit + ' ≠ crédit ' + total_credit);
  }
  const dateObj = new Date(date);
  const mois = dateObj.getMonth() + 1;
  const annee = dateObj.getFullYear();
  const periode = await prisma.periodeComptable.findFirst({
    where: { mois, annee, societe }
  });
  if (periode?.locked) {
    throw new Error('Période ' + periode.mois + '/' + periode.annee + ' est clôturée');
  }
  return prisma.ecritureComptable.createMany({
    data: lignes.map(l => ({
      journal,
      piece_ref,
      libelle,
      societe,
      created_by,
      date: dateObj,
      compte_id: l.compte_id,
      debit: l.debit || 0,
      credit: l.credit || 0
    }))
  });
}

export async function getSoldeCompte(prisma: any, compte_id: number) {
  const agg = await prisma.ecritureComptable.aggregate({
    where: { compte_id },
    _sum: { debit: true, credit: true }
  });
  return (agg._sum.debit || 0) - (agg._sum.credit || 0);
}

export async function ensureDefaultAccounts(prisma: any, societe: string) {
  const defaults = [
    { code: "411", nom: "Clients", type: "ACTIF", sens_normal: "DEBIT" },
    { code: "401", nom: "Fournisseurs", type: "PASSIF", sens_normal: "CREDIT" },
    { code: "512", nom: "Banque", type: "ACTIF", sens_normal: "DEBIT" },
    { code: "571", nom: "Caisse", type: "ACTIF", sens_normal: "DEBIT" },
    { code: "706", nom: "Prestations de services", type: "PRODUIT", sens_normal: "CREDIT" },
    { code: "604", nom: "Achats de matières", type: "CHARGE", sens_normal: "DEBIT" },
    { code: "445", nom: "TVA collectée", type: "PASSIF", sens_normal: "CREDIT" },
    { code: "4456", nom: "TVA déductible", type: "ACTIF", sens_normal: "DEBIT" },
    { code: "641", nom: "Salaires", type: "CHARGE", sens_normal: "DEBIT" },
    { code: "431", nom: "CNPS patronal", type: "PASSIF", sens_normal: "CREDIT" },
    { code: "641100", nom: "Charges sociales", type: "CHARGE", sens_normal: "DEBIT" }
  ];

  for (const item of defaults) {
    const existing = await prisma.compteComptable.findUnique({
      where: { code: item.code }
    });
    if (!existing) {
      await prisma.compteComptable.create({
        data: {
          code: item.code,
          nom: item.nom,
          type: item.type,
          sens_normal: item.sens_normal,
          societe: societe,
          actif: true
        }
      });
    }
  }
}

export async function postPaymentEcriture(
  prisma: any,
  {
    userId,
    societe,
    documentNumero,
    clientNom,
    montant,
    date,
    moyen
  }: {
    userId: number;
    societe: string;
    documentNumero: string;
    clientNom: string;
    montant: number;
    date: Date | string;
    moyen: string;
  }
) {
  await ensureDefaultAccounts(prisma, societe);
  const comptes = await prisma.compteComptable.findMany({ where: { societe } });
  
  // Use 571 (Caisse) if the payment method is cash, otherwise fallback to 512
  const isCash = moyen === "ESPECES" || moyen === "CASH" || moyen === "CAISSE";
  const moneyCompte = isCash 
    ? (comptes.find((c: any) => c.code === "571") || comptes.find((c: any) => c.code === "512"))
    : (comptes.find((c: any) => c.code === "512") || comptes.find((c: any) => c.code === "571"));
    
  const c411 = comptes.find((c: any) => c.code === "411");

  if (!moneyCompte || !c411) {
    throw new Error("Comptes requis (512/571, 411) introuvables.");
  }

  await postEcriture(prisma, {
    journal: isCash ? 'CAI' : 'BNQ',
    piece_ref: documentNumero,
    libelle: `Règlement ${documentNumero} — ${clientNom}`,
    societe,
    created_by: userId,
    date,
    lignes: [
      { compte_id: moneyCompte.id, debit: montant, credit: 0 },
      { compte_id: c411.id, debit: 0, credit: montant }
    ]
  });
}


