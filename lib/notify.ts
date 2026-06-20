import prisma from "./prismaClient";

/**
 * Sends a notification to all users matching a specific role.
 */
export async function notify(recipientRole: string, title: string, content: string) {
  console.log(`[NOTIFICATION] [To: ${recipientRole}] [${title}]: ${content}`);
  try {
    // We can find users of this role to write activity entries or trace them
    const users = await prisma.user.findMany({
      where: { role: recipientRole }
    });
    
    // Create an ActivityLog entry to persist the notification
    const adminUser = await prisma.user.findFirst({
      where: { role: "super_admin" }
    });
    
    const userId = adminUser ? adminUser.id : (users[0] ? users[0].id : 1);
    
    await prisma.activityLog.create({
      data: {
        user_id: userId,
        action: `NOTIFICATION_SENT_${recipientRole.toUpperCase()}`,
        entity: "Notification",
        meta: JSON.stringify({ role: recipientRole, title, content })
      }
    });
  } catch (error) {
    console.error("Error sending notification:", error);
  }
}
