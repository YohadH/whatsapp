// Reset an admin user's password from the command line (local/ops use).
//
//   node scripts/reset-admin-password.mjs <email> [newPassword]
//
// Defaults to "admin123" when no password is given, and always sets
// mustResetPassword so the next login forces choosing a fresh password.
// Exists because the seed's upsert intentionally never overwrites an existing
// user's hash (update: {}), so re-seeding cannot recover a forgotten password.
import bcrypt from 'bcryptjs';
import prisma from '../src/lib/prisma.js';

const [email, password = 'admin123'] = process.argv.slice(2);
if (!email) {
  console.error('usage: node scripts/reset-admin-password.mjs <email> [newPassword]');
  process.exit(1);
}
if (password.length < 6) {
  console.error('password must be at least 6 characters');
  process.exit(1);
}

const user = await prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });
if (!user) {
  console.error(`no admin user with email ${email}`);
  process.exit(1);
}
await prisma.adminUser.update({
  where: { id: user.id },
  data: { passwordHash: await bcrypt.hash(password, 10), mustResetPassword: true },
});
console.log(`✓ ${user.email} (${user.role}) password reset — will be asked to choose a new one on next login`);
await prisma.$disconnect();
