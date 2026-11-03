const bcrypt = require('bcryptjs');
const { assertSubdomainAllowed } = require('../../lib/reservedSlugs');
const prisma = require('../../config/database');
const { signAccessToken, signRefreshToken } = require('../../utils/jwt');
const { audit } = require('../../utils/audit');

const REFRESH_TTL_DAYS = 30;

const notificationClient = require('../../lib/notificationClient');
const speakeasy = require('speakeasy');
const { hashToken, randomToken } = require('../../utils/tokens');
const otp = require('../../lib/otp');

const BCRYPT_ROUNDS = 12;
// Compared against when the email is unknown so a missing account costs the
// same time as a wrong password and login cannot be used to enumerate users.
const DUMMY_HASH = bcrypt.hashSync('ladygreener-timing-equaliser', BCRYPT_ROUNDS);

const OTP_WINDOW_MS = 15 * 60 * 1000;
const OTP_MAX_FAILURES = 5;

function httpError(status, message, errors) {
  const err = new Error(message);
  err.status = status;
  if (errors) err.errors = errors;
  return err;
}

async function assertNotLocked(userId, failedPurpose) {
  if ((await otp.recentFailures(userId, failedPurpose, OTP_WINDOW_MS)) >= OTP_MAX_FAILURES) {
    throw httpError(429, 'Too many incorrect attempts. Please wait a few minutes and try again.');
  }
}

/** Verifies a TOTP code for a user with a bounded number of wrong guesses. */
async function verifyTotp(user, code) {
  await assertNotLocked(user.id, 'LOGIN_2FA_FAILED');
  const ok = !!user.twoFactorSecret && speakeasy.totp.verify({
    secret: user.twoFactorSecret,
    encoding: 'base32',
    token: String(code),
    window: 1,
  });
  if (!ok) await otp.recordFailure(user.id, 'LOGIN_2FA_FAILED', OTP_WINDOW_MS);
  return ok;
}

/**
 * Registers a new cleaning business and its owner in one transaction.
 * This is the tenant-creation entry point — every business starts here.
 */
async function registerBusiness({ businessName, subdomain, firstName, lastName, email, phone, password }) {
  // First, before any lookup: a reserved name is rejected the same way for everyone.
  assertSubdomainAllowed(subdomain);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const err = new Error('An account with this email already exists');
    err.status = 409;
    throw err;
  }

  const subdomainTaken = await prisma.business.findUnique({ where: { subdomain } });
  if (subdomainTaken) {
    const err = new Error('That subdomain is already taken');
    err.status = 409;
    throw err;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email, phone, firstName, lastName, passwordHash, isEmailVerified: false },
    });

    const business = await tx.business.create({
      data: {
        name: businessName,
        subdomain,
        branding: { create: {} },
        hours: {
          create: Array.from({ length: 7 }, (_, dayOfWeek) => ({
            dayOfWeek,
            openTime: '08:00',
            closeTime: '18:00',
            isClosed: dayOfWeek === 0,
          })),
        },
      },
    });

    await tx.businessMember.create({
      data: { businessId: business.id, userId: user.id, role: 'BUSINESS_OWNER', joinedAt: new Date() },
    });

    return { user, business };
  });

  await audit({
    businessId: result.business.id,
    actorUserId: result.user.id,
    action: 'BUSINESS_REGISTERED',
    entityType: 'Business',
    entityId: result.business.id,
  });

  return issueSession(result.user.id, result.business.id);
}

async function login({ email, password, twoFactorCode, businessId, userAgent, ipAddress }) {
  const user = await prisma.user.findUnique({ where: { email } });
  const passwordOk = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !passwordOk) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    throw err;
  }
  if (!user.isActive) {
    const err = new Error('This account has been deactivated');
    err.status = 403;
    throw err;
  }

  if (user.twoFactorEnabled) {
    if (!twoFactorCode) {
      const err = new Error('Two-factor authentication code required');
      err.status = 401;
      err.errors = { code: 'TWO_FACTOR_REQUIRED' };
      throw err;
    }
    const ok = await verifyTotp(user, twoFactorCode);
    if (!ok) {
      const err = new Error('Invalid two-factor authentication code');
      err.status = 401;
      err.errors = { code: 'TWO_FACTOR_INVALID' };
      throw err;
    }
  }

  // A user can be affiliated with more than one business now — as staff at
  // several businesses, a cleaner at several businesses, or both.
  const affiliations = await listAffiliations(user.id);

  if (affiliations.length > 1 && !businessId) {
    // Ambiguous — let the client show a "choose a workspace" screen.
    return { requiresBusinessSelection: true, affiliations };
  }

  const chosen = businessId
    ? affiliations.find((a) => a.businessId === businessId)
    : affiliations[0];
  if (businessId && !chosen) {
    const err = new Error('You are not affiliated with that business');
    err.status = 403;
    throw err;
  }

  return issueSession(user.id, chosen?.businessId || null, { userAgent, ipAddress });
}

/** Every business a user can currently act within, as staff and/or as a cleaner. */
async function listAffiliations(userId) {
  const [memberships, cleanerProfiles] = await Promise.all([
    prisma.businessMember.findMany({
      where: { userId, isActive: true },
      include: { business: { select: { id: true, name: true, subdomain: true } } },
    }),
    prisma.cleanerProfile.findMany({
      where: { userId, status: 'ACTIVE' },
      include: { business: { select: { id: true, name: true, subdomain: true } } },
    }),
  ]);

  return [
    ...memberships.map((m) => ({
      businessId: m.businessId,
      businessName: m.business.name,
      subdomain: m.business.subdomain,
      role: m.role,
    })),
    ...cleanerProfiles.map((c) => ({
      businessId: c.businessId,
      businessName: c.business.name,
      subdomain: c.business.subdomain,
      role: 'CLEANER',
    })),
  ];
}

/** Re-issues a session for a specific business (after ambiguous login or mid-session switch). */
async function selectBusiness(userId, businessId, meta = {}) {
  const affiliations = await listAffiliations(userId);
  const chosen = affiliations.find((a) => a.businessId === businessId);
  if (!chosen) {
    const err = new Error('You are not affiliated with that business');
    err.status = 403;
    throw err;
  }
  return issueSession(userId, businessId, meta);
}

async function issueSession(userId, businessId, meta = {}) {
  const accessToken = signAccessToken({ userId, businessId });
  const refreshToken = signRefreshToken();

  await prisma.session.create({
    data: {
      userId,
      businessId, // pin the session to this workspace
      // Only the hash is stored: the raw token is returned to the client once.
      refreshToken: hashToken(refreshToken),
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
      expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });

  // Bundle the resolved identity into the token response so clients (the
  // cleaner app in particular) don't need a second round-trip just to know
  // who just logged in. Kept lightweight — full self-service detail (own
  // availability, documents) still lives behind /cleaners/me/*.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, firstName: true, lastName: true, phone: true, avatarKey: true },
  });

  let cleanerProfile = null;
  if (businessId) {
    const membership = await prisma.businessMember.findFirst({
      where: { businessId, userId, isActive: true },
    });
    if (!membership) {
      const cleaner = await prisma.cleanerProfile.findFirst({
        where: { businessId, userId, status: 'ACTIVE' },
        include: { business: { select: { id: true, name: true } } },
      });
      if (cleaner) {
        cleanerProfile = {
          id: cleaner.id,
          businessId: cleaner.businessId,
          userId: cleaner.userId,
          status: cleaner.status,
          hireDate: cleaner.hireDate,
          businessName: cleaner.business.name,
          serviceAreaIds: cleaner.serviceAreaIds,
        };
      }
    }
  }

  let avatarUrl = null;
  if (user?.avatarKey) {
    try {
      const { getSignedDownloadUrl } = require('../../config/storage');
      avatarUrl = await getSignedDownloadUrl(user.avatarKey);
    } catch (e) {
      avatarUrl = null;
    }
  }

  return {
    accessToken,
    refreshToken,
    user: user ? { ...user, avatarUrl } : null,
    cleanerProfile,
  };
}

async function refresh(refreshToken) {
  // Sessions created before token hashing was introduced hold the raw value,
  // so fall back to it. Those rows expire within REFRESH_TTL_DAYS.
  const session = await prisma.session.findFirst({
    where: { OR: [{ refreshToken: hashToken(refreshToken) }, { refreshToken }] },
  });
  if (!session || session.expiresAt < new Date()) {
    throw httpError(401, 'Refresh token invalid or expired');
  }

  // Rotate atomically. With findUnique + delete, two concurrent refreshes with
  // the same token could both succeed; deleteMany reports how many rows it
  // removed, so only one caller wins.
  const { count } = await prisma.session.deleteMany({ where: { id: session.id } });
  if (count !== 1) throw httpError(401, 'Refresh token invalid or expired');

  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { isActive: true } });
  if (!user || !user.isActive) throw httpError(401, 'Refresh token invalid or expired');

  // Stay in the same workspace this session was issued for.
  const affiliations = await listAffiliations(session.userId);
  const stillValid = session.businessId && affiliations.some((a) => a.businessId === session.businessId);
  const businessId = stillValid ? session.businessId : (affiliations[0]?.businessId || null);

  return issueSession(session.userId, businessId, { userAgent: session.userAgent, ipAddress: session.ipAddress });
}

async function logout(refreshToken) {
  await prisma.session.deleteMany({
    where: { OR: [{ refreshToken: hashToken(refreshToken) }, { refreshToken }] },
  });
}

async function requestPasswordReset(email) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return;
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60);
  // Store the hash; the raw token only ever exists in the emailed link.
  await prisma.passwordReset.create({ data: { userId: user.id, token: hashToken(token), expiresAt } });
  // NOTE: this must match the actual frontend page, which lives at
  // /reset-password (not /auth/password-reset/confirm — there is no such
  // route in the Next.js app; see lady_frontend's
  // (full-width-pages)/(auth)/reset-password/page.tsx).
  const resetUrl = `${process.env.APP_URL || 'https://app.ladygreener.nl'}/reset-password?token=${token}`;
  await notificationClient.sendEmail({
    to: user.email,
    subject: 'Reset your password',
    text: `Reset link: ${resetUrl}`,
  });
}

async function confirmPasswordReset(token, newPassword) {
  // Legacy rows (created before hashing) hold the raw token; accept both.
  const pr = await prisma.passwordReset.findFirst({
    where: { OR: [{ token: hashToken(token) }, { token }] },
    include: { user: true },
  });
  if (!pr || pr.usedAt || pr.expiresAt < new Date()) {
    const err = new Error('Invalid or expired token');
    err.status = 400;
    throw err;
  }
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await prisma.user.update({ where: { id: pr.userId }, data: { passwordHash: hash } });
  await prisma.passwordReset.update({ where: { id: pr.id }, data: { usedAt: new Date() } });
  await prisma.session.deleteMany({ where: { userId: pr.userId } });
  await audit({
    businessId: null,
    actorUserId: pr.userId,
    action: 'PASSWORD_RESET',
    entityType: 'User',
    entityId: pr.userId,
  });
}

async function requestEmailVerify(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw httpError(404, 'User not found');

  // Only the newest code is valid.
  await prisma.otpCode.updateMany({
    where: { userId, purpose: 'EMAIL_VERIFY', consumedAt: null },
    data: { consumedAt: new Date() },
  });
  const code = otp.generateNumericCode();
  await prisma.otpCode.create({
    data: {
      userId,
      code: otp.hashOtp(userId, code),
      purpose: 'EMAIL_VERIFY',
      expiresAt: new Date(Date.now() + OTP_WINDOW_MS),
    },
  });
  await notificationClient.sendEmail({
    to: user.email,
    subject: 'Verify your email',
    text: `Your verification code: ${code}`,
  });
}

async function confirmEmailVerify(userId, code) {
  await assertNotLocked(userId, 'EMAIL_VERIFY_FAILED');
  const record = await prisma.otpCode.findFirst({
    where: { userId, code: otp.hashOtp(userId, String(code)), purpose: 'EMAIL_VERIFY', consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!record || record.expiresAt < new Date()) {
    await otp.recordFailure(userId, 'EMAIL_VERIFY_FAILED', OTP_WINDOW_MS);
    throw httpError(400, 'Invalid or expired code');
  }
  await prisma.user.update({ where: { id: userId }, data: { isEmailVerified: true } });
  await prisma.otpCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
  await otp.clearFailures(userId, 'EMAIL_VERIFY_FAILED');
}

async function generate2FASecret(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { twoFactorEnabled: true } });
  // Overwriting the secret of an account that already has 2FA would let anyone
  // holding a stolen access token swap in their own authenticator.
  if (user && user.twoFactorEnabled) {
    throw httpError(409, 'Two-factor authentication is already enabled. Disable it first to set it up again.');
  }
  const secret = speakeasy.generateSecret({ length: 20 });
  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorSecret: secret.base32 },
  });
  return { otpauth_url: secret.otpauth_url, base32: secret.base32 };
}

async function verifyAndEnable2FA(userId, token) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.twoFactorSecret) throw httpError(400, '2FA not initialized');
  const ok = await verifyTotp(user, token);
  if (!ok) throw httpError(400, 'Invalid 2FA token');
  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorEnabled: true },
  });
}

/**
 * Turning 2FA off requires the current password and a valid authenticator
 * code, not just a session. Previously any valid access token could disable it.
 */
async function disable2FA(userId, { password, code } = {}) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw httpError(404, 'User not found');
  if (!user.twoFactorEnabled) return;

  if (!password || !code) throw httpError(422, 'Password and a current authenticator code are required');
  if (!(await bcrypt.compare(password, user.passwordHash))) throw httpError(401, 'Incorrect password');
  if (!(await verifyTotp(user, code))) throw httpError(401, 'Invalid two-factor authentication code');

  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorEnabled: false, twoFactorSecret: null },
  });
  // Existing sessions were established under 2FA; make the user sign in again.
  await prisma.session.deleteMany({ where: { userId } });
  await audit({ businessId: null, actorUserId: userId, action: 'TWO_FACTOR_DISABLED', entityType: 'User', entityId: userId });
}

async function getCurrentUser({ id, globalRole, businessId, businessRole }) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      isEmailVerified: true,
      twoFactorEnabled: true,
      createdAt: true,
    },
  });
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }

  const business = businessId
      ? await prisma.business.findUnique({
        where: { id: businessId },
        select: { id: true, name: true, subdomain: true, timezone: true },
      })
      : null;

  return { ...user, globalRole, businessId, businessRole, business };
}

async function updateCurrentUser(userId, { firstName, lastName, phone }) {
  const data = {};
  if (typeof firstName === 'string' && firstName.trim()) data.firstName = firstName.trim();
  if (typeof lastName === 'string' && lastName.trim()) data.lastName = lastName.trim();
  if (phone !== undefined) data.phone = phone ? String(phone).trim() : null;

  if (Object.keys(data).length === 0) {
    const err = new Error('No fields to update');
    err.status = 400;
    throw err;
  }

  return prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      isEmailVerified: true,
      twoFactorEnabled: true,
      createdAt: true,
    },
  });
}

async function changePassword(userId, { currentPassword, newPassword }) {
  if (!currentPassword || !newPassword) {
    const err = new Error('currentPassword and newPassword are required');
    err.status = 400;
    throw err;
  }
  if (String(newPassword).length < 8) {
    const err = new Error('New password must be at least 8 characters');
    err.status = 400;
    throw err;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) {
    const err = new Error('Current password is incorrect');
    err.status = 401;
    throw err;
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await prisma.session.deleteMany({ where: { userId } });
  return null;
}

// Single export object — do not assign module.exports more than once
module.exports = {
  registerBusiness,
  login,
  refresh,
  logout,
  requestPasswordReset,
  confirmPasswordReset,
  requestEmailVerify,
  confirmEmailVerify,
  generate2FASecret,
  verifyAndEnable2FA,
  disable2FA,
  getCurrentUser,
  updateCurrentUser,
  changePassword,
  listAffiliations,
  selectBusiness,
};
