const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');
const { normalizePhone, findCustomerByPhone } = require('../../lib/phone');

async function listCustomers(businessId, { q, take = 200 } = {}) {
  const where = { businessId };
  if (q) {
    where.OR = [
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q } },
      { email: { contains: q, mode: 'insensitive' } },
    ];
  }
  return prisma.customer.findMany({
    where,
    include: {
      addresses: true,
      _count: { select: { bookings: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(take) || 200, 500),
  });
}

async function createCustomer(businessId, actorUserId, payload) {
  const { firstName, lastName, email, notes, address } = payload;
  const phone = normalizePhone(payload.phone);
  // The unique index only catches byte-identical numbers; check every format.
  if (await findCustomerByPhone(prisma, businessId, phone)) {
    const err = new Error('A customer with this phone number already exists');
    err.status = 409;
    throw err;
  }
  const created = await prisma.customer.create({
    data: {
      businessId,
      firstName,
      lastName,
      email: email || null,
      phone,
      notes: notes || null,
      ...(address
        ? {
            addresses: {
              create: {
                label: address.label || 'Primary',
                line1: address.line1,
                line2: address.line2 || null,
                city: address.city,
                state: address.state,
                postalCode: address.postalCode || '',
                latitude: address.latitude ?? null,
                longitude: address.longitude ?? null,
                isPrimary: true,
              },
            },
          }
        : {}),
    },
    include: { addresses: true },
  });
  await audit({ businessId, actorUserId, action: 'CUSTOMER_CREATED', entityType: 'Customer', entityId: created.id });
  return created;
}

async function getCustomer(businessId, id) {
  const c = await prisma.customer.findFirst({
    where: { id, businessId },
    include: {
      addresses: true,
      bookings: {
        orderBy: { scheduledStart: 'desc' },
        take: 50,
        include: { service: true, assignments: { include: { cleaner: { include: { user: true } } } } },
      },
      recurringSchedules: { where: { status: 'ACTIVE' } },
      reviews: true,
    },
  });
  if (!c) {
    const err = new Error('Customer not found');
    err.status = 404;
    throw err;
  }
  if (!c.referralCode) {
    c.referralCode = await ensureReferralCode(c.id);
  }
  return c;
}

/**
 * Lazily assigns a referral code to a customer that doesn't have one yet —
 * covers both customers created before this feature existed and the normal
 * signup path, so there's no separate backfill migration to run. Retries on
 * the rare collision instead of trusting randomness alone, since the column
 * is unique.
 */
async function ensureReferralCode(customerId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    try {
      const updated = await prisma.customer.update({
        where: { id: customerId },
        data: { referralCode: code },
        select: { referralCode: true },
      });
      return updated.referralCode;
    } catch (e) {
      if (e.code === 'P2002') continue; // collision on referralCode — retry with a new one
      throw e;
    }
  }
  throw new Error('Could not generate a unique referral code');
}

function generateReferralCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

async function updateCustomer(businessId, id, actorUserId, patch) {
  await getCustomer(businessId, id);
  const allowed = ['firstName', 'lastName', 'email', 'phone', 'notes'];
  const data = {};
  for (const k of allowed) {
    if (patch[k] !== undefined) data[k] = patch[k];
  }
  if (data.phone !== undefined) {
    data.phone = normalizePhone(data.phone);
    const clash = await findCustomerByPhone(prisma, businessId, data.phone);
    if (clash && clash.id !== id) {
      const err = new Error('A customer with this phone number already exists');
      err.status = 409;
      throw err;
    }
  }
  const updated = await prisma.customer.update({ where: { id }, data, include: { addresses: true } });
  await audit({ businessId, actorUserId, action: 'CUSTOMER_UPDATED', entityType: 'Customer', entityId: id, metadata: data });
  return updated;
}

const REDACTED = 'Verwijderd';

async function anonymizeCustomer(businessId, customerId) {
  await prisma.$transaction(async (tx) => {
    await tx.customerAddress.deleteMany({ where: { customerId } });
    await tx.recurringSchedule.updateMany({ where: { customerId, status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED' } });
    await tx.waitlistEntry.updateMany({
      where: { businessId, customerId },
      data: { contactName: null, contactEmail: null, contactPhone: null, notes: null },
    });
    // Location and access details on past bookings identify the person's home.
    await tx.booking.updateMany({
      where: { businessId, customerId },
      data: {
        addressLine1: REDACTED,
        addressLine2: null,
        city: '',
        state: '',
        postalCode: null,
        latitude: null,
        longitude: null,
        accessCode: null,
        keyLocation: null,
        parkingInstructions: null,
        petNotes: null,
        specialInstructions: null,
      },
    });
    // phone is required and unique per business, so leave a unique placeholder.
    await tx.customer.update({
      where: { id: customerId },
      data: {
        firstName: REDACTED,
        lastName: 'Klant',
        email: null,
        phone: `deleted-${customerId}`,
        notes: null,
        referralCode: null,
      },
    });
    // The portal login identity and any codes issued to it.
    const portalUser = await tx.user.findUnique({ where: { email: `portal-${customerId}@portal.invalid` }, select: { id: true } });
    if (portalUser) {
      await tx.otpCode.deleteMany({ where: { userId: portalUser.id } });
      await tx.user.delete({ where: { id: portalUser.id } });
    }
  });
}

async function deleteCustomer(businessId, id, actorUserId) {
  await getCustomer(businessId, id);
  // Soft approach: refuse if they have future bookings
  const future = await prisma.booking.count({
    where: {
      customerId: id,
      businessId,
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
      scheduledStart: { gte: new Date() },
    },
  });
  if (future > 0) {
    const err = new Error('Cannot delete customer with upcoming bookings — cancel them first');
    err.status = 422;
    throw err;
  }
  // Anonymise instead of deleting. A hard delete cascaded to the customer's
  // bookings, payroll earnings and reviews, destroying financial records the
  // business is legally required to keep (in the Netherlands the tax
  // administration must be retained for years) while the customer's actual
  // request — erase my personal data — is served just as well by removing
  // everything that identifies them and keeping the accounting rows.
  await anonymizeCustomer(businessId, id);
  await audit({ businessId, actorUserId, action: 'CUSTOMER_ANONYMIZED', entityType: 'Customer', entityId: id });
}

async function addAddress(businessId, customerId, actorUserId, payload) {
  await getCustomer(businessId, customerId);
  if (payload.isPrimary) {
    await prisma.customerAddress.updateMany({ where: { customerId }, data: { isPrimary: false } });
  }
  const address = await prisma.customerAddress.create({
    data: {
      customerId,
      label: payload.label || null,
      line1: payload.line1,
      line2: payload.line2 || null,
      city: payload.city,
      state: payload.state,
      postalCode: payload.postalCode || '',
      latitude: payload.latitude ?? null,
      longitude: payload.longitude ?? null,
      isPrimary: !!payload.isPrimary,
      accessCode: payload.accessCode || null,
      keyLocation: payload.keyLocation || null,
      parkingInstructions: payload.parkingInstructions || null,
      petNotes: payload.petNotes || null,
      specialInstructions: payload.specialInstructions || null,
    },
  });
  await audit({ businessId, actorUserId, action: 'CUSTOMER_ADDRESS_ADDED', entityType: 'CustomerAddress', entityId: address.id });
  return address;
}

async function updateAddress(businessId, customerId, addressId, actorUserId, patch) {
  const address = await prisma.customerAddress.findFirst({
    where: { id: addressId, customerId, customer: { businessId } },
  });
  if (!address) {
    const err = new Error('Address not found');
    err.status = 404;
    throw err;
  }
  if (patch.isPrimary) {
    await prisma.customerAddress.updateMany({ where: { customerId }, data: { isPrimary: false } });
  }
  const allowed = [
    'label', 'line1', 'line2', 'city', 'state', 'postalCode', 'latitude', 'longitude', 'isPrimary',
    'accessCode', 'keyLocation', 'parkingInstructions', 'petNotes', 'specialInstructions',
  ];
  const data = {};
  for (const k of allowed) {
    if (patch[k] !== undefined) data[k] = patch[k];
  }
  const updated = await prisma.customerAddress.update({ where: { id: addressId }, data });
  await audit({ businessId, actorUserId, action: 'CUSTOMER_ADDRESS_UPDATED', entityType: 'CustomerAddress', entityId: addressId });
  return updated;
}

async function deleteAddress(businessId, customerId, addressId, actorUserId) {
  const address = await prisma.customerAddress.findFirst({
    where: { id: addressId, customerId, customer: { businessId } },
  });
  if (!address) {
    const err = new Error('Address not found');
    err.status = 404;
    throw err;
  }
  await prisma.customerAddress.delete({ where: { id: addressId } });
  await audit({ businessId, actorUserId, action: 'CUSTOMER_ADDRESS_DELETED', entityType: 'CustomerAddress', entityId: addressId });
}

module.exports = {
  listCustomers,
  createCustomer,
  getCustomer,
  updateCustomer,
  deleteCustomer,
  addAddress,
  updateAddress,
  deleteAddress,
  ensureReferralCode,
};
