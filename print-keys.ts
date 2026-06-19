import { Prisma } from "@prisma/client";

async function main() {
  console.log("Dossier fields check in Prisma types:");
  // Let's print out the exact type definition properties for Dossier select or include
  const dummy: Prisma.DossierInclude = {
    client: true,
    taches: true,
    bons_provisoir: true,
    bons_reel: true,
  };
  console.log("TypeScript compile check OK! Dummy object:", dummy);
}

main().catch(console.error);
