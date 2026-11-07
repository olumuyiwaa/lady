/**
 * The people who can sign in to a business account's portal besides the account
 * holder. Managed by the company's own admins (portal) and by staff (dashboard).
 *
 * A member signs in with their own email or phone (same one-time code flow as
 * customers). Their email/phone must not belong to an existing customer or to
 * another member of the business, so a login always resolves to one person.
 */
const prisma = require('../../config/database');
const b2b = require('../../lib/b2bAccount');
const { ROLES } = require('../../lib/companyScope');
const { normalizePhone, findCustomerByPhone, phoneLookupVariants } = require('../../lib/phone');

const MAX_MEMBERS = 25;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const label = (b) => [b.addressLine1, [b.postalCode, b.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');

async function loadCompany(businessId, customerId) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer || !b2b.isBusinessAccount(customer)) throw httpError(403, 'This is only available for business accounts');
  return customer;
}

/** The company's known branches: every distinct service address it has booked. */
async function listLocations(businessId, customerId) {
  const rows = await prisma.booking.findMany({
    where: { businessId, customerId },
    select: { addressLine1: true, postalCode: true, city: true, scheduledStart: true },
    orderBy: { scheduledStart: 'desc' },
    take: 5000,
  });
  const map = new Map();
  for (const r of rows) {
    const key = b2b.locationKey(r);
    if (!map.has(key)) map.set(key, { key, label: label(r) });
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

const present = (m) => ({
  id: m.id, firstName: m.firstName, lastName: m.lastName, email: m.email, phone: m.phone,
  role: m.role, locationKeys: m.locationKeys, isActive: m.isActive,
});

async function list(businessId, customerId) {
  await loadCompany(businessId, customerId);
  const rows = await prisma.companyMember.findMany({ where: { businessId, customerId }, orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }], take: MAX_MEMBERS + 25 });
  return rows.map(present);
}

/** Validates and normalises the fields present in `input` (all of them on create). */
async function clean(businessId, customerId, input, { creating, existing } = {}) {
  const out = {};
  const str = (v) => (v == null ? '' : String(v).trim());
  const has = (k) => input[k] !== undefined;

  if (creating || has('firstName')) {
    const v = str(input.firstName);
    if (!v) throw httpError(422, 'First name is required');
    out.firstName = v.slice(0, 80);
  }
  if (creating || has('lastName')) out.lastName = str(input.lastName).slice(0, 80);

  if (creating || has('email')) {
    const v = str(input.email).toLowerCase();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw httpError(422, 'Email is not a valid email address');
    out.email = v || null;
  }
  if (creating || has('phone')) {
    const raw = str(input.phone);
    const v = raw ? normalizePhone(raw) : null;
    if (raw && !v) throw httpError(422, 'Phone number is not valid');
    out.phone = v;
  }
  const email = has('email') || creating ? out.email : existing.email;
  const phone = has('phone') || creating ? out.phone : existing.phone;
  if (!email && !phone) throw httpError(422, 'An email address or a phone number is required to sign in');

  if (creating || has('role')) {
    if (!ROLES.includes(input.role)) throw httpError(422, 'Role must be ADMIN or BRANCH_MANAGER');
    out.role = input.role;
  }
  const role = out.role || existing.role;
  if (role === 'ADMIN') {
    out.locationKeys = [];
  } else if (creating || has('locationKeys') || out.role) {
    const keys = Array.isArray(input.locationKeys) ? [...new Set(input.locationKeys.map(String))] : (existing && existing.role === 'BRANCH_MANAGER' ? existing.locationKeys : []);
    if (!keys.length) throw httpError(422, 'Choose at least one location for a branch manager');
    const known = new Set((await listLocations(businessId, customerId)).map((l) => l.key));
    if (keys.some((k) => !known.has(k))) throw httpError(422, 'Unknown location');
    out.locationKeys = keys;
  }
  if (has('isActive')) out.isActive = !!input.isActive;
  return out;
}

/** A login identifier must resolve to exactly one person in the business. */
async function assertIdentifiersFree(businessId, customerId, { email, phone }, exceptMemberId) {
  if (phone) {
    const c = await findCustomerByPhone(prisma, businessId, phone);
    if (c && c.id !== customerId) throw httpError(409, 'This phone number already belongs to another customer');
    const m = await prisma.companyMember.findFirst({ where: { businessId, phone: { in: phoneLookupVariants(phone) }, ...(exceptMemberId ? { id: { not: exceptMemberId } } : {}) } });
    if (m) throw httpError(409, 'This phone number is already used by another team member');
  }
  if (email) {
    const c = await prisma.customer.findFirst({ where: { businessId, email: { equals: email, mode: 'insensitive' }, id: { not: customerId } } });
    if (c) throw httpError(409, 'This email address already belongs to another customer');
    const m = await prisma.companyMember.findFirst({ where: { businessId, email: { equals: email, mode: 'insensitive' }, ...(exceptMemberId ? { id: { not: exceptMemberId } } : {}) } });
    if (m) throw httpError(409, 'This email address is already used by another team member');
  }
}

async function create(businessId, customerId, input = {}) {
  await loadCompany(businessId, customerId);
  const count = await prisma.companyMember.count({ where: { businessId, customerId, isActive: true } });
  if (count >= MAX_MEMBERS) throw httpError(422, `A company can have at most ${MAX_MEMBERS} team members`);
  const data = await clean(businessId, customerId, input, { creating: true });
  await assertIdentifiersFree(businessId, customerId, data);
  return present(await prisma.companyMember.create({ data: { businessId, customerId, ...data } }));
}

async function update(businessId, customerId, memberId, input = {}, { actorMemberId } = {}) {
  await loadCompany(businessId, customerId);
  const existing = await prisma.companyMember.findFirst({ where: { id: memberId, businessId, customerId } });
  if (!existing) throw httpError(404, 'Team member not found');
  const data = await clean(businessId, customerId, input, { existing });
  if (actorMemberId === memberId && (data.isActive === false || (data.role && data.role !== 'ADMIN'))) {
    throw httpError(422, 'You cannot remove your own admin access');
  }
  await assertIdentifiersFree(businessId, customerId, { email: data.email !== undefined ? data.email : existing.email, phone: data.phone !== undefined ? data.phone : existing.phone }, memberId);
  return present(await prisma.companyMember.update({ where: { id: memberId }, data }));
}

/** Members are switched off, not deleted, so reports and audit trails keep their names. */
async function deactivate(businessId, customerId, memberId, opts) {
  return update(businessId, customerId, memberId, { isActive: false }, opts);
}

module.exports = { list, create, update, deactivate, listLocations, MAX_MEMBERS };
