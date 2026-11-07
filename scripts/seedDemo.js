/**
 * Demo seed for Tod Cleaning Services — fills every major dashboard page.
 *
 * Prerequisites:
 *   1. Basic bootstrap already ran:
 *        OWNER_EMAIL=... OWNER_PASSWORD=... npm run seed
 *   2. DATABASE_URL is set in .env
 *
 * Usage:
 *   node scripts/seedDemo.js
 *
 * Safe to re-run: it skips entities that already exist (by email/phone/code).
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { locationKey } = require('../src/lib/b2bAccount');

const prisma = new PrismaClient();

const SLUG = process.env.BUSINESS_SLUG || 'todcleaning';
const PASSWORD = process.env.DEMO_PASSWORD || 'DemoPass123!';

function daysFromNow(n, hour = 10) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    d.setHours(hour, 0, 0, 0);
    return d;
}

function daysAgo(n, hour = 10) {
    return daysFromNow(-n, hour);
}

async function main() {
    const business = await prisma.business.findUnique({ where: { subdomain: SLUG } });
    if (!business) {
        throw new Error(`Business "${SLUG}" not found. Run npm run seed first.`);
    }
    const bid = business.id;
    console.log('Seeding demo data for', business.name, bid);

    // ─── Address + service area ───────────────────────────────────────
    let address = await prisma.businessAddress.findFirst({ where: { businessId: bid } });
    if (!address) {
        address = await prisma.businessAddress.create({
            data: {
                businessId: bid,
                label: 'Kantoor',
                line1: 'Prinsengracht 263',
                city: 'Amsterdam',
                state: 'NH',
                postalCode: '1016 GV',
                country: 'NL',
                latitude: 52.3731,
                longitude: 4.8922,
                isPrimary: true,
            },
        });
        console.log('✓ Business address');
    }

    let area = await prisma.serviceArea.findFirst({ where: { businessId: bid } });
    if (!area) {
        area = await prisma.serviceArea.create({
            data: {
                businessId: bid,
                name: 'Amsterdam centrum + ring',
                centerLat: 52.3676,
                centerLng: 4.9041,
                radiusMeters: 15000,
            },
        });
        console.log('✓ Service area');
    }

    // Enrich pricing (deposit + cancel policy)
    await prisma.businessPricing.updateMany({
        where: { businessId: bid },
        data: {
            depositType: 'PERCENT',
            depositValue: 20,
            cancellationWindowHours: 24,
            cancellationFeeType: 'PERCENT',
            cancellationFeeValue: 50,
            sizeUnit: 'SQM',
        },
    });

    // ─── Services ─────────────────────────────────────────────────────
    let services = await prisma.service.findMany({ where: { businessId: bid } });
    if (services.length === 0) {
        await prisma.service.createMany({
            data: [
                {
                    businessId: bid,
                    name: 'Huishoudelijke schoonmaak',
                    description: 'Regelmatige schoonmaak van woonruimtes.',
                    pricingModel: 'HOURLY',
                    basePriceCents: 3500,
                    estimatedMinutes: 120,
                    isActive: true,
                },
                {
                    businessId: bid,
                    name: 'Diepte-schoonmaak',
                    description: 'Grondige schoonmaak inclusief apparaten.',
                    pricingModel: 'FLAT',
                    basePriceCents: 18900,
                    estimatedMinutes: 240,
                    isActive: true,
                },
                {
                    businessId: bid,
                    name: 'Verhuisschoonmaak',
                    description: 'Oplevering voor verhuur of verkoop.',
                    pricingModel: 'FLAT',
                    basePriceCents: 24900,
                    estimatedMinutes: 300,
                    isActive: true,
                },
            ],
        });
        services = await prisma.service.findMany({ where: { businessId: bid } });
        console.log('✓ Services');
    }
    const [svcRegular, svcDeep, svcMove] = services;

    // ─── Staff: manager + cleaners ────────────────────────────────────
    const hash = await bcrypt.hash(PASSWORD, 12);

    async function upsertUser({ email, phone, firstName, lastName }) {
        let u = await prisma.user.findUnique({ where: { email } });
        if (!u) {
            u = await prisma.user.create({
                data: {
                    email,
                    phone,
                    passwordHash: hash,
                    firstName,
                    lastName,
                    globalRole: 'PLATFORM_USER',
                    isEmailVerified: true,
                    isActive: true,
                },
            });
        }
        return u;
    }

    const manager = await upsertUser({
        email: 'manager@todcleaning.nl',
        phone: '+31611110001',
        firstName: 'Marieke',
        lastName: 'de Vries',
    });
    await prisma.businessMember.upsert({
        where: { businessId_userId: { businessId: bid, userId: manager.id } },
        update: {},
        create: {
            businessId: bid,
            userId: manager.id,
            role: 'BUSINESS_MANAGER',
            isActive: true,
            joinedAt: new Date(),
        },
    });

    const cleanerUsers = [
        { email: 'sofia@todcleaning.nl', phone: '+31611110002', firstName: 'Sofia', lastName: 'Bakker' },
        { email: 'jan@todcleaning.nl', phone: '+31611110003', firstName: 'Jan', lastName: 'Jansen' },
        { email: 'amina@todcleaning.nl', phone: '+31611110004', firstName: 'Amina', lastName: 'Hassan' },
    ];

    const cleaners = [];
    for (const c of cleanerUsers) {
        const user = await upsertUser(c);
        let profile = await prisma.cleanerProfile.findUnique({
            where: { businessId_userId: { businessId: bid, userId: user.id } },
        });
        if (!profile) {
            profile = await prisma.cleanerProfile.create({
                data: {
                    businessId: bid,
                    userId: user.id,
                    status: 'ACTIVE',
                    hireDate: daysAgo(90),
                    employmentType: c.firstName === 'Jan' ? 'ZZP' : 'EMPLOYEE',
                    serviceAreaIds: [area.id],
                    lastKnownLat: 52.37 + Math.random() * 0.02,
                    lastKnownLng: 4.89 + Math.random() * 0.02,
                    lastKnownAt: new Date(),
                },
            });
            // Availability Mon–Fri 08:00–17:00
            for (let day = 1; day <= 5; day++) {
                await prisma.cleanerAvailability.create({
                    data: {
                        cleanerId: profile.id,
                        dayOfWeek: day,
                        startTime: '08:00',
                        endTime: '17:00',
                    },
                });
            }
            // Compensation
            await prisma.cleanerCompensation.create({
                data: {
                    businessId: bid,
                    cleanerId: profile.id,
                    type: c.firstName === 'Jan' ? 'FLAT_PER_JOB' : 'PERCENT',
                    value: c.firstName === 'Jan' ? 5500 : 40, // €55 flat or 40%
                },
            });
        }
        cleaners.push(profile);
    }
    console.log('✓ Manager + 3 cleaners (password:', PASSWORD + ')');

    // Cleaner documents
    for (const cl of cleaners) {
        const count = await prisma.cleanerDocument.count({ where: { cleanerId: cl.id } });
        if (count === 0) {
            await prisma.cleanerDocument.createMany({
                data: [
                    {
                        businessId: bid,
                        cleanerId: cl.id,
                        type: 'VOG',
                        title: 'VOG certificaat',
                        storageKey: `demo/vog-${cl.id}.pdf`,
                        mimeType: 'application/pdf',
                        expiresAt: daysFromNow(180),
                    },
                    {
                        businessId: bid,
                        cleanerId: cl.id,
                        type: 'ID_CARD',
                        title: 'ID / paspoort',
                        storageKey: `demo/id-${cl.id}.pdf`,
                        mimeType: 'application/pdf',
                    },
                ],
            });
        }
    }

    // ─── Customers ────────────────────────────────────────────────────
    const customerDefs = [
        { firstName: 'Lisa', lastName: 'van Dam', email: 'lisa@example.nl', phone: '+31620000001', city: 'Amsterdam', postal: '1017 CT', line1: 'Keizersgracht 100' },
        { firstName: 'Tom', lastName: 'Visser', email: 'tom@example.nl', phone: '+31620000002', city: 'Amsterdam', postal: '1071 JN', line1: 'Van Baerlestraat 22' },
        { firstName: 'Fatima', lastName: 'El Amrani', email: 'fatima@example.nl', phone: '+31620000003', city: 'Amstelveen', postal: '1181 CD', line1: 'Rembrandtweg 45' },
        { firstName: 'Pieter', lastName: 'Smit', email: 'pieter@example.nl', phone: '+31620000004', city: 'Amsterdam', postal: '1054 XG', line1: 'Overtoom 300' },
        { firstName: 'Emma', lastName: 'de Boer', email: 'emma@example.nl', phone: '+31620000005', city: 'Amsterdam', postal: '1015 BJ', line1: 'Haarlemmerstraat 88' },
    ];

    const customers = [];
    for (const def of customerDefs) {
        let cust = await prisma.customer.findFirst({
            where: { businessId: bid, phone: def.phone },
        });
        if (!cust) {
            cust = await prisma.customer.create({
                data: {
                    businessId: bid,
                    firstName: def.firstName,
                    lastName: def.lastName,
                    email: def.email,
                    phone: def.phone,
                    notes: 'Demo klant',
                    referralCode: `REF-${def.firstName.toUpperCase()}`,
                    addresses: {
                        create: {
                            label: 'Thuis',
                            line1: def.line1,
                            city: def.city,
                            state: 'NH',
                            postalCode: def.postal,
                            latitude: 52.36 + Math.random() * 0.03,
                            longitude: 4.88 + Math.random() * 0.04,
                            isPrimary: true,
                            accessCode: '1234#',
                            petNotes: def.firstName === 'Lisa' ? 'Kleine hond, vriendelijk' : null,
                            specialInstructions: 'Bel aan bij voordeur',
                        },
                    },
                },
                include: { addresses: true },
            });
        } else {
            cust = await prisma.customer.findUnique({
                where: { id: cust.id },
                include: { addresses: true },
            });
        }
        customers.push(cust);
    }
    console.log('✓ 5 customers with addresses');

    // ─── Coupons + gift cards ─────────────────────────────────────────
    const couponCodes = [
        { code: 'WELCOME10', type: 'PERCENT', value: 10 },
        { code: 'LENTE25', type: 'AMOUNT', value: 2500 },
    ];
    for (const c of couponCodes) {
        await prisma.coupon.upsert({
            where: { businessId_code: { businessId: bid, code: c.code } },
            update: {},
            create: {
                businessId: bid,
                code: c.code,
                type: c.type,
                value: c.value,
                isActive: true,
                maxRedemptions: 100,
                expiresAt: daysFromNow(90),
            },
        });
    }

    const giftCode = 'GIFT50';
    let gift = await prisma.giftCard.findUnique({
        where: { businessId_code: { businessId: bid, code: giftCode } },
    });
    if (!gift) {
        gift = await prisma.giftCard.create({
            data: {
                businessId: bid,
                code: giftCode,
                initialValueCents: 5000,
                balanceCents: 5000,
                recipientEmail: customers[0].email,
                recipientName: customers[0].firstName,
                message: 'Veel schoonmaakplezier!',
                isActive: true,
                expiresAt: daysFromNow(365),
            },
        });
    }
    console.log('✓ Coupons + gift card');

    // ─── Booking questions ────────────────────────────────────────────
    const qCount = await prisma.bookingQuestion.count({ where: { businessId: bid } });
    if (qCount === 0) {
        await prisma.bookingQuestion.createMany({
            data: [
                {
                    businessId: bid,
                    label: 'Heeft u huisdieren?',
                    type: 'YES_NO',
                    required: true,
                    sortOrder: 1,
                },
                {
                    businessId: bid,
                    label: 'Verdieping',
                    type: 'SELECT',
                    options: ['Begane grond', '1e verdieping', '2e of hoger'],
                    required: false,
                    sortOrder: 2,
                },
                {
                    businessId: bid,
                    label: 'Extra wensen',
                    type: 'LONG_TEXT',
                    required: false,
                    sortOrder: 3,
                },
            ],
        });
        console.log('✓ Booking questions');
    }

    // ─── Bookings across all statuses ─────────────────────────────────
    const existingBookings = await prisma.booking.count({ where: { businessId: bid } });
    if (existingBookings === 0) {
        const addr = (c) => c.addresses[0];

        // 1. COMPLETED + PAID + review + earning + invoice
        const b1 = await prisma.booking.create({
            data: {
                businessId: bid,
                customerId: customers[0].id,
                serviceId: svcRegular.id,
                addressLine1: addr(customers[0]).line1,
                city: addr(customers[0]).city,
                state: 'NH',
                postalCode: addr(customers[0]).postalCode,
                latitude: addr(customers[0]).latitude,
                longitude: addr(customers[0]).longitude,
                accessCode: addr(customers[0]).accessCode,
                petNotes: addr(customers[0]).petNotes,
                scheduledStart: daysAgo(5, 9),
                scheduledEnd: daysAgo(5, 11),
                status: 'COMPLETED',
                quotedPriceCents: 7000,
                paymentStatus: 'PAID',
                amountPaidCents: 7000,
                termsAcceptedAt: daysAgo(7),
                homeDetails: { rooms: 3, bathrooms: 1, sqft: 75, frequency: 'WEEKLY' },
                assignments: {
                    create: {
                        cleanerId: cleaners[0].id,
                        isTeamLead: true,
                        checkedInAt: daysAgo(5, 9),
                        checkedOutAt: daysAgo(5, 11),
                    },
                },
                checklist: {
                    create: {
                        items: [
                            { label: 'Keuken', done: true },
                            { label: 'Badkamer', done: true },
                            { label: 'Stofzuigen', done: true },
                        ],
                        completedAt: daysAgo(5, 11),
                    },
                },
                review: {
                    create: {
                        businessId: bid,
                        customerId: customers[0].id,
                        cleanerId: cleaners[0].id,
                        rating: 5,
                        comment: 'Super netjes gedaan, dank je Sofia!',
                    },
                },
                cleanerEarnings: {
                    create: {
                        businessId: bid,
                        cleanerId: cleaners[0].id,
                        amountCents: 2800,
                        compensationType: 'PERCENT',
                        compensationValue: 40,
                        status: 'PENDING',
                        earnedAt: daysAgo(5, 11),
                    },
                },
            },
        });

        // Invoice for completed job
        await prisma.invoice.create({
            data: {
                businessId: bid,
                bookingId: b1.id,
                customerId: customers[0].id,
                sequence: 1,
                number: 'LG-2026-0001',
                currency: 'eur',
                vatRateBps: 2100,
                netCents: 5785,
                vatCents: 1215,
                grossCents: 7000,
                supplier: {
                    name: 'Tod Cleaning Services',
                    kvk: '12345678',
                    vat: 'NL123456789B01',
                    address: 'Prinsengracht 263, 1016 GV Amsterdam',
                },
                customerSnapshot: {
                    name: `${customers[0].firstName} ${customers[0].lastName}`,
                    email: customers[0].email,
                    address: `${addr(customers[0]).line1}, ${addr(customers[0]).postalCode} ${addr(customers[0]).city}`,
                },
                lines: [
                    {
                        description: 'Huishoudelijke schoonmaak (2u)',
                        quantity: 1,
                        unitPriceCents: 7000,
                        totalCents: 7000,
                    },
                ],
                issuedAt: daysAgo(4),
                dueAt: daysAgo(4),
                paidAt: daysAgo(4),
            },
        });
        await prisma.invoiceCounter.upsert({
            where: { businessId: bid },
            update: { lastSequence: 1 },
            create: { businessId: bid, lastSequence: 1 },
        });

        // Transaction for payment
        await prisma.transaction.create({
            data: {
                businessId: bid,
                type: 'BOOKING_PAYMENT',
                direction: 'IN',
                status: 'SUCCEEDED',
                method: 'STRIPE',
                amountCents: 7000,
                currency: 'EUR',
                occurredAt: daysAgo(4),
                description: 'Betaling booking LG-2026-0001',
                counterpartyName: `${customers[0].firstName} ${customers[0].lastName}`,
                bookingId: b1.id,
                customerId: customers[0].id,
                dedupeKey: `demo-payment-${b1.id}`,
            },
        });

        // 2. COMPLETED (for second cleaner) — ready for payout
        const b2 = await prisma.booking.create({
            data: {
                businessId: bid,
                customerId: customers[1].id,
                serviceId: svcDeep.id,
                addressLine1: addr(customers[1]).line1,
                city: addr(customers[1]).city,
                state: 'NH',
                postalCode: addr(customers[1]).postalCode,
                scheduledStart: daysAgo(3, 10),
                scheduledEnd: daysAgo(3, 14),
                status: 'COMPLETED',
                quotedPriceCents: 18900,
                paymentStatus: 'PAID',
                amountPaidCents: 18900,
                termsAcceptedAt: daysAgo(5),
                assignments: {
                    create: {
                        cleanerId: cleaners[1].id,
                        isTeamLead: true,
                        checkedInAt: daysAgo(3, 10),
                        checkedOutAt: daysAgo(3, 14),
                    },
                },
                cleanerEarnings: {
                    create: {
                        businessId: bid,
                        cleanerId: cleaners[1].id,
                        amountCents: 5500,
                        compensationType: 'FLAT_PER_JOB',
                        compensationValue: 5500,
                        status: 'PENDING',
                        earnedAt: daysAgo(3, 14),
                    },
                },
            },
        });

        // 3. IN_PROGRESS (today)
        await prisma.booking.create({
            data: {
                businessId: bid,
                customerId: customers[2].id,
                serviceId: svcRegular.id,
                addressLine1: addr(customers[2]).line1,
                city: addr(customers[2]).city,
                state: 'NH',
                postalCode: addr(customers[2]).postalCode,
                scheduledStart: daysFromNow(0, 9),
                scheduledEnd: daysFromNow(0, 11),
                status: 'IN_PROGRESS',
                quotedPriceCents: 7000,
                paymentStatus: 'DEPOSIT_PAID',
                depositRequiredCents: 1400,
                depositPaidAt: daysAgo(1),
                amountPaidCents: 1400,
                termsAcceptedAt: daysAgo(2),
                assignments: {
                    create: {
                        cleanerId: cleaners[0].id,
                        isTeamLead: true,
                        onMyWayAt: daysFromNow(0, 8),
                        checkedInAt: daysFromNow(0, 9),
                    },
                },
            },
        });

        // 4. ASSIGNED (tomorrow)
        await prisma.booking.create({
            data: {
                businessId: bid,
                customerId: customers[3].id,
                serviceId: svcRegular.id,
                addressLine1: addr(customers[3]).line1,
                city: addr(customers[3]).city,
                state: 'NH',
                postalCode: addr(customers[3]).postalCode,
                scheduledStart: daysFromNow(1, 13),
                scheduledEnd: daysFromNow(1, 15),
                status: 'ASSIGNED',
                quotedPriceCents: 7000,
                paymentStatus: 'UNPAID',
                termsAcceptedAt: daysAgo(1),
                assignments: {
                    create: { cleanerId: cleaners[2].id, isTeamLead: true },
                },
            },
        });

        // 5. CONFIRMED (day after tomorrow) — unassigned for dispatch testing
        await prisma.booking.create({
            data: {
                businessId: bid,
                customerId: customers[4].id,
                serviceId: svcMove.id,
                addressLine1: addr(customers[4]).line1,
                city: addr(customers[4]).city,
                state: 'NH',
                postalCode: addr(customers[4]).postalCode,
                scheduledStart: daysFromNow(2, 9),
                scheduledEnd: daysFromNow(2, 14),
                status: 'CONFIRMED',
                quotedPriceCents: 24900,
                paymentStatus: 'UNPAID',
                termsAcceptedAt: new Date(),
            },
        });

        // 6. REQUESTED
        await prisma.booking.create({
            data: {
                businessId: bid,
                customerId: customers[1].id,
                serviceId: svcRegular.id,
                addressLine1: addr(customers[1]).line1,
                city: addr(customers[1]).city,
                state: 'NH',
                postalCode: addr(customers[1]).postalCode,
                scheduledStart: daysFromNow(4, 10),
                scheduledEnd: daysFromNow(4, 12),
                status: 'REQUESTED',
                quotedPriceCents: 7000,
                paymentStatus: 'UNPAID',
                termsAcceptedAt: new Date(),
            },
        });

        // 7. CANCELLED
        await prisma.booking.create({
            data: {
                businessId: bid,
                customerId: customers[2].id,
                serviceId: svcDeep.id,
                addressLine1: addr(customers[2]).line1,
                city: addr(customers[2]).city,
                state: 'NH',
                postalCode: addr(customers[2]).postalCode,
                scheduledStart: daysAgo(1, 14),
                scheduledEnd: daysAgo(1, 18),
                status: 'CANCELLED',
                quotedPriceCents: 18900,
                paymentStatus: 'REFUNDED',
                cancelReason: 'Klant heeft verhuisdatum verschoven',
                cancellationFeeCents: 0,
                refundedAmountCents: 3780,
                refundedAt: daysAgo(1),
                termsAcceptedAt: daysAgo(3),
            },
        });

        console.log('✓ Bookings (all statuses)');
    }

    // ─── Recurring schedule ───────────────────────────────────────────
    const recCount = await prisma.recurringSchedule.count({ where: { businessId: bid } });
    if (recCount === 0) {
        await prisma.recurringSchedule.create({
            data: {
                businessId: bid,
                customerId: customers[0].id,
                serviceId: svcRegular.id,
                customerAddressId: customers[0].addresses[0]?.id,
                frequency: 'WEEKLY',
                dayOfWeek: 2, // Tuesday
                startTime: '09:00',
                status: 'ACTIVE',
                nextRunDate: daysFromNow(7, 9),
            },
        });
        console.log('✓ Recurring schedule');
    }

    // ─── Waitlist ─────────────────────────────────────────────────────
    const wlCount = await prisma.waitlistEntry.count({ where: { businessId: bid } });
    if (wlCount === 0) {
        await prisma.waitlistEntry.create({
            data: {
                businessId: bid,
                customerId: customers[3].id,
                contactName: `${customers[3].firstName} ${customers[3].lastName}`,
                contactEmail: customers[3].email,
                contactPhone: customers[3].phone,
                serviceId: svcDeep.id,
                desiredStart: daysFromNow(3, 9),
                desiredEnd: daysFromNow(3, 13),
                notes: 'Liefst ochtend',
                status: 'WAITING',
            },
        });
        console.log('✓ Waitlist entry');
    }

    // ─── Inventory ────────────────────────────────────────────────────
    let loc = await prisma.inventoryLocation.findFirst({ where: { businessId: bid } });
    if (!loc) {
        loc = await prisma.inventoryLocation.create({
            data: {
                businessId: bid,
                name: 'Magazijn Amsterdam',
                type: 'WAREHOUSE',
                address: 'Prinsengracht 263, Amsterdam',
                isActive: true,
            },
        });
    }

    const invCount = await prisma.inventoryItem.count({ where: { businessId: bid } });
    if (invCount === 0) {
        const items = await Promise.all(
            [
                { name: 'Allesreiniger', sku: 'CHEM-001', type: 'CHEMICAL', unit: 'liter', reorderPoint: 5, isHazardous: true },
                { name: 'Microvezel doeken', sku: 'SUP-001', type: 'SUPPLY', unit: 'stuks', reorderPoint: 20 },
                { name: 'Stofzuiger Dyson', sku: 'EQ-001', type: 'EQUIPMENT', unit: 'stuks', reorderPoint: 1 },
                { name: 'Wegwerphandschoenen', sku: 'PPE-001', type: 'PPE', unit: 'doos', reorderPoint: 3 },
            ].map((i) =>
                prisma.inventoryItem.create({
                    data: { businessId: bid, ...i, isActive: true },
                })
            )
        );

        // Stock levels + a movement
        for (const item of items) {
            await prisma.inventoryStock.create({
                data: {
                    itemId: item.id,
                    locationId: loc.id,
                    quantity: item.sku === 'CHEM-001' ? 3 : 25, // low stock on cleaner
                },
            });
        }
        await prisma.stockMovement.create({
            data: {
                businessId: bid,
                itemId: items[0].id,
                type: 'PURCHASE',
                quantity: 10,
                toLocationId: loc.id,       // inbound purchase → toLocation
                notes: 'Demo inkoop',
                performedById: manager.id,  // not createdBy
            },
        });
        console.log('✓ Inventory + stock');
    }

    // ─── Compliance ───────────────────────────────────────────────────
    const compCount = await prisma.complianceDocument.count({ where: { businessId: bid } });
    if (compCount === 0) {
        const sds = await prisma.complianceDocument.create({
            data: {
                businessId: bid,
                type: 'SDS',
                title: 'SDS Allesreiniger',
                storageKey: 'demo/sds-allesreiniger.pdf',
                mimeType: 'application/pdf',
                version: '1.2',
                effectiveAt: daysAgo(30),
                expiresAt: daysFromNow(335),
            },
        });
        await prisma.complianceAudit.create({
            data: {
                businessId: bid,
                title: 'Kwartaal veiligheidscheck',
                type: 'SAFETY',
                status: 'OPEN',
                conductedAt: daysFromNow(14),  // not scheduledAt
                notes: 'Controle PPE en chemische opslag',
            },
        });
        // Training ack for first cleaner
        await prisma.chemicalTrainingAck.create({
            data: {
                businessId: bid,
                cleanerId: cleaners[0].id,
                documentId: sds.id,
                notes: 'Training afgerond',
            },
        });
        console.log('✓ Compliance docs + audit');
    }

    // ─── Checklist template ───────────────────────────────────────────
    const tplCount = await prisma.checklistTemplate.count({ where: { businessId: bid } });
    if (tplCount === 0) {
        await prisma.checklistTemplate.create({
            data: {
                businessId: bid,
                name: 'Standaard huishouden',
                items: [
                    { label: 'Keuken: aanrecht + spoelbak' },
                    { label: 'Keuken: vloer dweilen' },
                    { label: 'Badkamer: toilet + douche' },
                    { label: 'Stofzuigen alle ruimtes' },
                    { label: 'Afval meenemen' },
                ],
            },
        });
        console.log('✓ Checklist template');
    }

    // ─── Support ticket ───────────────────────────────────────────────
    const ticketCount = await prisma.supportTicket.count({ where: { businessId: bid } });
    if (ticketCount === 0) {
        await prisma.supportTicket.create({
            data: {
                businessId: bid,
                subject: 'Vraag over terugkerende schoonmaak',
                description: 'Kan ik mijn wekelijkse schema wijzigen naar dinsdagochtend?',
                status: 'OPEN',
                priority: 'MEDIUM',
                category: 'BOOKING',
                customerId: customers[0].id,
                contactName: `${customers[0].firstName} ${customers[0].lastName}`,
                contactEmail: customers[0].email,
                source: 'WEBSITE',
                messages: {
                    create: {
                        body: 'Hallo, ik wil graag mijn vaste dag verzetten.',
                        authorId: null,
                    },
                },
            },
        });
        console.log('✓ Support ticket');
    }

    // ─── Messaging ────────────────────────────────────────────────────
    const convCount = await prisma.conversation.count({ where: { businessId: bid } });
    if (convCount === 0) {
        await prisma.conversation.create({
            data: {
                businessId: bid,
                subjectType: 'CUSTOMER',
                subjectId: customers[0].id,
                messages: {
                    create: [
                        {
                            senderUserId: manager.id,
                            body: 'Goedemiddag Lisa, je volgende afspraak staat gepland voor volgende week dinsdag.',
                        },
                        {
                            senderUserId: manager.id,
                            body: 'Laat het weten als je iets wilt aanpassen.',
                        },
                    ],
                },
            },
        });
        console.log('✓ Conversation');
    }

    // ─── Notifications for owner/manager ──────────────────────────────
    const ownerMember = await prisma.businessMember.findFirst({
        where: { businessId: bid, role: 'BUSINESS_OWNER' },
    });
    if (ownerMember) {
        const nCount = await prisma.notification.count({
            where: { businessId: bid, recipientUserId: ownerMember.userId },
        });
        if (nCount === 0) {
            await prisma.notification.createMany({
                data: [
                    {
                        businessId: bid,
                        recipientUserId: ownerMember.userId,
                        type: 'BOOKING_CONFIRMED',
                        title: 'Nieuwe boeking bevestigd',
                        body: 'Emma de Boer heeft een verhuisschoonmaak geboekt.',
                    },
                    {
                        businessId: bid,
                        recipientUserId: ownerMember.userId,
                        type: 'REVIEW_RECEIVED',
                        title: 'Nieuwe review (5★)',
                        body: 'Lisa van Dam heeft Sofia 5 sterren gegeven.',
                    },
                ],
            });
            console.log('✓ Notifications');
        }
    }

    // ─── Language + WhatsApp consent on the demo customers ────────────
    const langPlan = [
        { phone: '+31620000001', language: 'nl', whatsapp: true },
        { phone: '+31620000002', language: 'en', whatsapp: false },
        { phone: '+31620000003', language: 'nl', whatsapp: false },
        { phone: '+31620000005', language: 'nl', whatsapp: true },
    ];
    for (const l of langPlan) {
        await prisma.customer.updateMany({
            where: { businessId: bid, phone: l.phone, language: null },
            data: { language: l.language, ...(l.whatsapp ? { whatsappOptInAt: daysAgo(20) } : {}) },
        });
    }

    // ─── Cleaner leave: one approved, one waiting for a decision ──────
    if ((await prisma.cleanerLeave.count({ where: { businessId: bid } })) === 0) {
        await prisma.cleanerLeave.createMany({
            data: [
                { businessId: bid, cleanerId: cleaners[0].id, type: 'VACATION', status: 'APPROVED', startsAt: daysFromNow(14, 0), endsAt: daysFromNow(19, 0), reason: 'Vakantie', decidedAt: new Date() },
                { businessId: bid, cleanerId: cleaners[1].id, type: 'PERSONAL', status: 'PENDING', startsAt: daysFromNow(8, 0), endsAt: daysFromNow(9, 0), reason: 'Verhuizing' },
            ],
        });
        console.log('✓ Cleaner leave (1 approved, 1 pending)');
    }

    // ─── Business (B2B) accounts, branches, a month+ of visits, team ──
    const companyDefs = [
        {
            companyName: 'Acme Offices BV', firstName: 'Marieke', lastName: 'Visser', email: 'facilities@acme-demo.nl', phone: '+31620000101',
            kvk: '12345678', vat: 'NL123456789B01', terms: 30, language: 'nl',
            branches: [
                { line1: 'Damrak 70', postal: '1012 LM', city: 'Amsterdam' },
                { line1: 'Herengracht 450', postal: '1017 CA', city: 'Amsterdam' },
                { line1: 'Stationsplein 12', postal: '1012 AB', city: 'Amsterdam' },
            ],
            members: [
                { firstName: 'Marieke', lastName: 'Visser', email: 'marieke@acme-demo.nl', role: 'ADMIN', branch: [] },
                { firstName: 'Daan', lastName: 'Koster', email: 'daan@acme-demo.nl', role: 'BRANCH_MANAGER', branch: [0] },
                { firstName: 'Noor', lastName: 'Bos', email: 'noor@acme-demo.nl', role: 'BRANCH_MANAGER', branch: [1, 2] },
            ],
            // per branch: how often the cleaner is late / how many items stay undone / rating / complaints
            quality: [{ late: 0.1, undone: 0, rating: 5 }, { late: 0.5, undone: 1, rating: 3 }, { late: 0.2, undone: 0, rating: 4 }],
        },
        {
            companyName: 'Bright Dental Clinics', firstName: 'Sam', lastName: 'de Wit', email: 'office@brightdental-demo.nl', phone: '+31620000102',
            kvk: '87654321', vat: 'NL987654321B01', terms: 14, language: 'en',
            branches: [
                { line1: 'Overtoom 120', postal: '1054 HG', city: 'Amsterdam' },
                { line1: 'Rembrandtweg 8', postal: '1181 AA', city: 'Amstelveen' },
            ],
            members: [{ firstName: 'Sam', lastName: 'de Wit', email: 'sam@brightdental-demo.nl', role: 'ADMIN', branch: [] }],
            quality: [{ late: 0, undone: 0, rating: 5 }, { late: 0.3, undone: 2, rating: 4 }],
        },
    ];

    for (const def of companyDefs) {
        let company = await prisma.customer.findFirst({ where: { businessId: bid, phone: def.phone } });
        if (!company) {
            company = await prisma.customer.create({
                data: {
                    businessId: bid, firstName: def.firstName, lastName: def.lastName, email: def.email, phone: def.phone,
                    companyName: def.companyName, kvkNumber: def.kvk, vatNumber: def.vat, billingEmail: def.email,
                    paymentTermsDays: def.terms, language: def.language, notes: 'Demo zakelijk account',
                    referralCode: `REF-${def.companyName.split(' ')[0].toUpperCase()}`,
                },
            });
        }

        // Visits: every 3 days over the last ~45 days, rotating over the branches.
        if ((await prisma.booking.count({ where: { businessId: bid, customerId: company.id } })) === 0) {
            let n = 0;
            for (let day = 45; day >= 3; day -= 3) {
                const bi = n % def.branches.length;
                const branch = def.branches[bi];
                const q = def.quality[bi];
                const cleaner = cleaners[n % cleaners.length];
                const start = daysAgo(day, 7);
                const end = daysAgo(day, 9);
                const late = ((n * 37) % 100) / 100 < q.late; // deterministic
                const checkIn = new Date(start.getTime() + (late ? 25 : 2) * 60000);
                const items = ['Kantoor', 'Sanitair', 'Keuken', 'Vuilnis'].map((label, i) => ({ label, done: i >= q.undone }));
                const booking = await prisma.booking.create({
                    data: {
                        businessId: bid, customerId: company.id, serviceId: svcRegular.id,
                        addressLine1: branch.line1, city: branch.city, state: 'NH', postalCode: branch.postal,
                        scheduledStart: start, scheduledEnd: end, status: 'COMPLETED',
                        quotedPriceCents: 6050, paymentStatus: 'UNPAID', termsAcceptedAt: daysAgo(day + 2),
                        homeDetails: { frequency: 'WEEKLY' },
                        assignments: { create: { cleanerId: cleaner.id, isTeamLead: true, checkedInAt: checkIn, checkedOutAt: end } },
                        checklist: { create: { items, completedAt: end } },
                        ...(n % 2 === 0
                            ? { review: { create: { businessId: bid, customerId: company.id, cleanerId: cleaner.id, rating: q.rating, comment: null } } }
                            : {}),
                    },
                });
                // A complaint on the weaker branches now and then.
                if (q.rating <= 3 && n % 4 === 1) {
                    await prisma.supportTicket.create({
                        data: {
                            businessId: bid, customerId: company.id, bookingId: booking.id, cleanerId: cleaner.id,
                            subject: `Klacht over bezoek ${branch.line1}`, description: 'Sanitair was niet schoongemaakt.',
                            status: 'OPEN', priority: 'HIGH', category: 'QUALITY', kind: 'COMPLAINT',
                            contactName: `${def.firstName} ${def.lastName}`, contactEmail: def.email,
                        },
                    });
                }
                n += 1;
            }
            console.log(`✓ ${def.companyName}: ${def.branches.length} branches, ${n} visits`);
        }

        // Team members (login by one-time code to their own email).
        for (const m of def.members) {
            const exists = await prisma.companyMember.findFirst({ where: { businessId: bid, email: m.email } });
            if (exists) continue;
            await prisma.companyMember.create({
                data: {
                    businessId: bid, customerId: company.id, firstName: m.firstName, lastName: m.lastName, email: m.email, role: m.role,
                    locationKeys: m.branch.map((i) => locationKey({ addressLine1: def.branches[i].line1, postalCode: def.branches[i].postal, city: def.branches[i].city })),
                },
            });
        }
    }
    console.log('✓ Business accounts with team members');

    console.log('\n══════════════════════════════════════════════════');
    console.log('Demo seed complete. Sign in and explore:');
    console.log('');
    console.log('  Owner (from bootstrap):  OWNER_EMAIL / OWNER_PASSWORD');
    console.log('  Manager:                 manager@todcleaning.nl /', PASSWORD);
    console.log('  Cleaners:                sofia@… / jan@… / amina@… /', PASSWORD);
    console.log('');
    console.log('Pages to hit:');
    console.log('  Dashboard overview, Bookings, Calendar, Dispatch');
    console.log('  Cleaners + documents, Customers, Recurring');
    console.log('  Invoices, Payroll/earnings, Transactions');
    console.log('  Inventory, Compliance, Reviews, Waitlist');
    console.log('  Coupons/gift cards, Messages, Support tickets');
    console.log('  Leave, People > Business accounts (Acme Offices BV, Bright Dental Clinics)');
    console.log('');
    console.log('Company logins in the customer portal (one-time code, per member email):');
    console.log('  marieke@acme-demo.nl (admin), daan@acme-demo.nl (1 branch), noor@acme-demo.nl (2 branches), sam@brightdental-demo.nl (admin)');
    console.log('══════════════════════════════════════════════════\n');
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());