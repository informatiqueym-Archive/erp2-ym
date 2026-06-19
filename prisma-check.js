import fs from "fs";
import path from "path";
import { execSync } from "child_process";

console.log("🚀 [PRISMA-CHECK] Démarrage du script de résilience de la base de données...");

// Fonction utilitaire pour forcer une variable d'environnement dans .env et process.env
function forceEnvironmentVariable(key, value) {
  const envPath = path.resolve(".env");
  let envContent = "";
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf-8");
  } else if (fs.existsSync(".env.example")) {
    envContent = fs.readFileSync(".env.example", "utf-8");
  }

  const lines = envContent.split(/\r?\n/);
  let found = false;
  const newLines = lines.map((line) => {
    if (line.trim().startsWith(`${key}=`)) {
      found = true;
      return `${key}="${value}"`;
    }
    return line;
  });

  if (!found) {
    newLines.push(`${key}="${value}"`);
  }

  fs.writeFileSync(envPath, newLines.join("\n"));
  process.env[key] = value;
  console.log(`📡 [PRISMA-CHECK] .env mis à jour : ${key}="${value}"`);
}

// Fonction utilitaire pour supprimer en toute sécurité
function safeDelete(p) {
  if (fs.existsSync(p)) {
    try {
      const stats = fs.statSync(p);
      if (stats.isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
        console.log(`✅ [PRISMA-CHECK] Dossier supprimé avec succès : ${p}`);
      } else {
        fs.unlinkSync(p);
        console.log(`✅ [PRISMA-CHECK] Fichier supprimé avec succès : ${p}`);
      }
    } catch (err) {
      console.error(`❌ [PRISMA-CHECK] Impossible de supprimer ${p}: ${err.message}`);
    }
  }
}

// 1. Détermination initiale du chemin de la base de données
let dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.log("ℹ️ [PRISMA-CHECK] Aucune DATABASE_URL fournie. Configuration d'une base de données locale...");
  forceEnvironmentVariable("DATABASE_URL", "file:./dev.db");
  dbUrl = "file:./dev.db";
}

let dbPath = path.resolve("prisma", "dev.db");
if (dbUrl && dbUrl.startsWith("file:")) {
  const filePath = dbUrl.substring(5);
  dbPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve("prisma", filePath);
}

console.log(`📍 [PRISMA-CHECK] Chemin de la base de données configuré : ${dbPath}`);

// 2. Vérification des permissions d'écriture sur le répertoire de destination
const dbDir = path.dirname(dbPath);
let isWriteable = false;

try {
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  // Test d'écriture
  const testFile = path.join(dbDir, `.write-test-${Date.now()}`);
  fs.writeFileSync(testFile, "test");
  fs.unlinkSync(testFile);
  isWriteable = true;
  console.log(`✅ [PRISMA-CHECK] Le dossier de destination ${dbDir} a des droits d'écriture d'accès valides.`);
} catch (writeErr) {
  console.error(`⚠️ [PRISMA-CHECK] Le dossier ${dbDir} n'est PAS accessible en écriture : ${writeErr.message}`);
}

// 3. Bascule préventive si le répertoire de destination n'est pas accessible en écriture
if (!isWriteable) {
  console.log("⚠️ [PRISMA-CHECK] Bascule automatique sur la base de données locale sécurisée ./prisma/dev.db...");
  forceEnvironmentVariable("DATABASE_URL", "file:./dev.db");
  dbPath = path.resolve("prisma", "dev.db");
  const localDir = path.dirname(dbPath);
  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
  }
}

// 4. Validation physique du fichier SQLite s'il y en a un existant
if (fs.existsSync(dbPath)) {
  try {
    const stats = fs.statSync(dbPath);
    if (stats.isDirectory()) {
      console.log(`⚠️ [PRISMA-CHECK] ${dbPath} est détecté comme un dossier. Suppression préventive...`);
      safeDelete(dbPath);
    } else {
      const fd = fs.openSync(dbPath, "r");
      const buffer = Buffer.alloc(16);
      fs.readSync(fd, buffer, 0, 16, 0);
      fs.closeSync(fd);

      const header = buffer.toString("utf-8", 0, 15);
      if (header !== "SQLite format 3") {
        console.log(`⚠️ [PRISMA-CHECK] Fichier corrompu détecté à ${dbPath}. Suppression préventive...`);
        safeDelete(dbPath);
      } else {
        console.log(`✅ [PRISMA-CHECK] SQLite valide détecté à ${dbPath}.`);
      }
    }
  } catch (error) {
    console.log(`⚠️ [PRISMA-CHECK] Impossible de valider ${dbPath}. Nettoyage automatique...`, error.message);
    safeDelete(dbPath);
  }
}

// 5. Exécution du push Prisma avec rattrapage total
let pushSuccess = false;
try {
  console.log("👉 [PRISMA-CHECK] Lancement de : npx prisma db push --accept-data-loss");
  execSync("npx prisma db push --accept-data-loss", { stdio: "inherit" });
  pushSuccess = true;
  try {
    console.log("👉 [PRISMA-CHECK] Régénération du client Prisma après push...");
    execSync("npx prisma generate", { stdio: "inherit" });
    console.log("✅ [PRISMA-CHECK] Client Prisma régénéré.");
  } catch (genErr) {
    console.error("❌ [PRISMA-CHECK] Erreur génération client:", genErr.message);
  }
} catch (error) {
  console.error("⚠️ [PRISMA-CHECK] Premier essai de push échoué. Tentative de réinitialisation physique...");
  safeDelete(dbPath);
  // Nettoyer les fichiers journaux
  const journalFiles = [dbPath + "-journal", dbPath + "-shm", dbPath + "-wal"];
  for (const jFile of journalFiles) {
    safeDelete(jFile);
  }

  try {
    console.log("👉 [PRISMA-CHECK] Seconde tentative de push...");
    execSync("npx prisma db push --accept-data-loss", { stdio: "inherit" });
    pushSuccess = true;
  } catch (secondError) {
    console.error("❌ [PRISMA-CHECK] Seconde tentative de push échouée :", secondError.message);
  }
}

// 6. Si le push a toujours échoué, bascule forcée ultime de sauvetage sur dev.db locale
if (!pushSuccess && dbPath !== path.resolve("prisma", "dev.db")) {
  console.log("🚨 [PRISMA-CHECK] Erreurs persistantes sur la base principale. Bascule forcée d'urgence sur la base locale ./prisma/dev.db...");
  forceEnvironmentVariable("DATABASE_URL", "file:./dev.db");
  dbPath = path.resolve("prisma", "dev.db");
  
  // S'assurer que les journaux locaux soient propres
  safeDelete(dbPath);
  const journalFiles = [dbPath + "-journal", dbPath + "-shm", dbPath + "-wal"];
  for (const jFile of journalFiles) {
    safeDelete(jFile);
  }

  try {
    console.log("👉 [PRISMA-CHECK] Tentative de push de sauvetage locale...");
    execSync("npx prisma db push --accept-data-loss", { stdio: "inherit" });
    pushSuccess = true;
  } catch (fallbackError) {
    console.error("❌ [PRISMA-CHECK] Échec ultime du push de sauvetage locale :", fallbackError.message);
  }
}

  if (pushSuccess && fs.existsSync(dbPath)) {
    try {
      console.log("👉 [PRISMA-CHECK] Vérification des colonnes manquantes...");
      const Database = (await import("better-sqlite3").catch(() => null))?.default;
      if (Database) {
        const db = new Database(dbPath);
        const safeAlter = (sql) => {
          try { db.exec(sql); }
          catch (e) { /* Colonne déjà existante — normal */ }
        };
        safeAlter("ALTER TABLE Dossier ADD COLUMN representant TEXT DEFAULT ''");
        safeAlter("ALTER TABLE Dossier ADD COLUMN pipeline_status TEXT DEFAULT 'ARCHIVE'");
        safeAlter("ALTER TABLE Dossier ADD COLUMN archived_at DATETIME");
        db.close();
        console.log("✅ [PRISMA-CHECK] Colonnes vérifiées.");
      } else {
        // Fallback using SQLite3 CLI
        try {
          const runSql = (sql) => {
            try {
              execSync(`sqlite3 "${dbPath}" "${sql}"`, { stdio: "ignore" });
            } catch (err) {
              // Ignore already exists / index error
            }
          };
          runSql("ALTER TABLE Dossier ADD COLUMN representant TEXT DEFAULT '';");
          runSql("ALTER TABLE Dossier ADD COLUMN pipeline_status TEXT DEFAULT 'ARCHIVE';");
          runSql("ALTER TABLE Dossier ADD COLUMN archived_at DATETIME;");
          console.log("✅ [PRISMA-CHECK] Colonnes vérifiées par CLI sqlite3.");
        } catch (cliErr) {
          console.log("ℹ️ [PRISMA-CHECK] sqlite3 CLI non disponible.");
        }
      }
    } catch (migErr) {
      console.log("ℹ️ [PRISMA-CHECK] Vérification colonnes ignorée:", migErr.message);
    }
  }

// 7. Seed Database
if (pushSuccess) {
  try {
    const seedPath = path.resolve("dist", "seed.cjs");
    if (fs.existsSync(seedPath)) {
      console.log("👉 [PRISMA-CHECK] Exécution du peuplement de données : node dist/seed.cjs");
      execSync("node dist/seed.cjs", { stdio: "inherit" });
    } else {
      console.log("ℹ️ [PRISMA-CHECK] Fichier seed.cjs absent de dist/. Le seed à froid sera exécuté par le serveur Express au démarrage.");
    }
  } catch (error) {
    console.error("⚠️ [PRISMA-CHECK] Échec lors du seed de la base :", error.message);
  }
} else {
  console.warn("⚠️ [PRISMA-CHECK] Impossible d'exécuter le seed car la structure de la base de données n'a pas pu être validée.");
}

console.log("✅ [PRISMA-CHECK] Procédure d'initialisation de la base de données terminée. Passage à l'application.");
