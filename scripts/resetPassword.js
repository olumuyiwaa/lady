/**
 * Set a new password for an existing user (e.g. the owner who cannot sign in).
 *
 *   EMAIL=owner@todcleaning.nl NEW_PASSWORD='a-long-password' npm run reset-password
 *
 * Prints whether the user exists, their role in the business, and whether the
 * account is usable. The seed script never changes an existing user's password,
 * so use this when the account was created earlier with a different password.
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const email = String(process.env.EMAIL || '').trim().toLowerCase();
  const password = process.env.NEW_PASSWORD;
  if (!email || !password) throw new Error('Set EMAIL and NEW_PASSWORD.');
  if (password.length < 12) throw new Error('NEW_PASSWORD must be at least 12 characters.');

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    include: { businessMemberships: true },
  });
  if (!user) {
    const all = await prisma.user.findMany({ select: { email: true }, take: 20 });
    throw new Error(`No user with email ${email}. Existing users: ${all.map((u) => u.email).join(', ') || '(none; run npm run seed)'}`);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(password, 12), isEmailVerified: true },
  });
  console.log(`✓ Password updated for ${user.email}`);
  console.log('  memberships:', user.businessMemberships.map((m) => `${m.role}${m.isActive ? '' : ' (inactive)'}`).join(', ') || 'none — sign-in will fail until they belong to a business');
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
