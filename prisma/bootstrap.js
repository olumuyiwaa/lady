/**
 * First-run setup for Lady Greener (a single cleaning business).
 *
 *   OWNER_EMAIL=anna@ladygreener.nl OWNER_PASSWORD='...' npm run seed
 *
 * Idempotent: running it again leaves existing rows alone. It creates the one
 * Business, its opening hours, default pricing, the owner account, and a
 * starter service list that the owner edits from the dashboard.
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const env = (k, fallback) => (process.env[k] && process.env[k].trim()) || fallback;

async function main() {
  const email = env('OWNER_EMAIL');
  const password = env('OWNER_PASSWORD');
  if (!email || !password) throw new Error('Set OWNER_EMAIL and OWNER_PASSWORD before seeding.');
  if (password.length < 12) throw new Error('OWNER_PASSWORD must be at least 12 characters.');

  const subdomain = env('BUSINESS_SLUG', 'ladygreener');

  let business = await prisma.business.findUnique({ where: { subdomain } });
  if (!business) {
    business = await prisma.business.create({
      data: {
        name: env('BUSINESS_NAME', 'Lady Greener'),
        subdomain,
        timezone: 'Europe/Amsterdam',
        defaultLocale: 'nl',
        branding: {
          create: {
            primaryColor: '#15803D',
            accentColor: '#F59E0B',
            tagline: 'Schoon, groen en zorgeloos',
            widgetEmbedEnabled: false,
          },
        },
        hours: {
          create: Array.from({ length: 7 }, (_, dayOfWeek) => ({
            dayOfWeek,
            openTime: '08:00',
            closeTime: '18:00',
            isClosed: dayOfWeek === 0,
          })),
        },
        // Payments go to our own Stripe account (see lib/stripeClient.js).
        stripeConnectedAccountId: 'direct',
        stripeConnectOnboarded: true,
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
        pricing: { create: { frequencyDiscounts: { WEEKLY: 0.1, BIWEEKLY: 0.05, MONTHLY: 0.0 } } },
      },
    });
    console.log('✓ Business created:', business.name);
  } else {
    console.log('✓ Business already exists:', business.name);
  }

  let owner = await prisma.user.findUnique({ where: { email } });
  if (!owner) {
    owner = await prisma.user.create({
      data: {
        email,
        phone: env('OWNER_PHONE', null),
        passwordHash: await bcrypt.hash(password, 12),
        firstName: env('OWNER_FIRST_NAME', 'Owner'),
        lastName: env('OWNER_LAST_NAME', 'Lady Greener'),
        globalRole: 'PLATFORM_USER',
        isEmailVerified: true,
      },
    });
    console.log('✓ Owner created:', email);
  }

  await prisma.businessMember.upsert({
    where: { businessId_userId: { businessId: business.id, userId: owner.id } },
    update: {},
    create: { businessId: business.id, userId: owner.id, role: 'BUSINESS_OWNER', isActive: true, joinedAt: new Date() },
  });

  if ((await prisma.service.count({ where: { businessId: business.id } })) === 0) {
    await prisma.service.createMany({
      data: [
        { businessId: business.id, name: 'Huishoudelijke schoonmaak', description: 'Regelmatige schoonmaak van woonruimtes, keuken en badkamer.', pricingModel: 'HOURLY', basePriceCents: 3500, estimatedMinutes: 120, isActive: true },
        { businessId: business.id, name: 'Diepte-schoonmaak', description: 'Grondige schoonmaak, inclusief apparaten en plinten.', pricingModel: 'FLAT', basePriceCents: 18900, estimatedMinutes: 240, isActive: true },
        { businessId: business.id, name: 'Verhuisschoonmaak', description: 'Oplevering-schoon voor verhuur of verkoop.', pricingModel: 'FLAT', basePriceCents: 24900, estimatedMinutes: 300, isActive: true },
      ],
    });
    console.log('✓ Starter services created (edit them in the dashboard)');
  }

  console.log('\nBUSINESS_ID=' + business.id + '   (optional: pin it in .env)');
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
