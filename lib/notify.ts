import prisma from "./prismaClient";

export async function notify(
  recipientRole: string, 
  titre: string, 
  contenu: string, 
  lien?: string
) {
  try {
    const users = await prisma.user.findMany({
      where: { role: recipientRole, actif: true }
    });
    for (const user of users) {
      await prisma.notification.create({
        data: { user_id: user.id, titre, contenu, lien: lien || null }
      });
    }
  } catch (e) {
    console.error("[NOTIFY] Error:", e);
  }
}

export async function notifyUser(
  userId: number,
  titre: string,
  contenu: string,
  lien?: string
) {
  try {
    await prisma.notification.create({
      data: { user_id: userId, titre, contenu, lien: lien || null }
    });
  } catch (e) {
    console.error("[NOTIFY USER] Error:", e);
  }
}
