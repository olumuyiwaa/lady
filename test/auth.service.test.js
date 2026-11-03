/**
 * These mocks previously used require.cache injection, which does not
 * actually intercept anything under Jest (Jest keeps its own module
 * registry, separate from Node's native require.cache — see
 * test/cancellationPolicy.test.js for the full explanation). That meant
 * this suite either failed outright in any environment without a
 * generated Prisma client, or — in an environment with one — silently ran
 * auth.service against the *real* database/notification/speakeasy modules
 * while asserting against mock objects nothing ever called, without ever
 * actually failing loudly because the calls it awaited resolved to
 * whatever the real modules happened to return. jest.mock() is the
 * technique that actually replaces the module.
 */
jest.mock('../src/config/database.js', () => ({
  user: { findUnique: jest.fn(), update: jest.fn() },
  passwordReset: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  otpCode: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  session: { create: jest.fn(), findFirst: jest.fn(), deleteMany: jest.fn() },
  businessMember: { findMany: jest.fn(), findFirst: jest.fn() },
  cleanerProfile: { findMany: jest.fn(), findFirst: jest.fn() },
  auditLog: { create: jest.fn() },
}));
jest.mock('../src/lib/notificationClient.js', () => ({
  sendEmail: jest.fn(),
  sendSms: jest.fn(),
  _sendEmailNow: jest.fn(),
}));
jest.mock('speakeasy', () => ({
  generateSecret: jest.fn(() => ({ base32: 'BASE32', otpauth_url: 'otpauth://x' })),
  totp: { verify: jest.fn() },
}));

const bcrypt = require('bcryptjs');
const mockPrisma = require('../src/config/database.js');
const mockNotif = require('../src/lib/notificationClient.js');
const mockSpeakeasy = require('speakeasy');
const authService = require('../src/modules/auth/auth.service');
const { hashToken } = require('../src/utils/tokens');
const otpLib = require('../src/lib/otp');

process.env.JWT_SECRET = 'test-secret';

describe('auth.service password reset and 2FA', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockPrisma.otpCode.count.mockResolvedValue(0);
    mockPrisma.auditLog.create.mockResolvedValue({});
    mockSpeakeasy.generateSecret.mockReturnValue({ base32: 'BASE32', otpauth_url: 'otpauth://x' });
  });

  test('requestPasswordReset emails the raw token and stores only its hash', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' });
    mockPrisma.passwordReset.create.mockResolvedValue({ id: 'pr1' });

    await authService.requestPasswordReset('a@b.com');

    const stored = mockPrisma.passwordReset.create.mock.calls[0][0].data.token;
    const emailed = mockNotif.sendEmail.mock.calls[0][0].text.match(/token=([a-f0-9]+)/)[1];
    expect(stored).toBe(hashToken(emailed));
    expect(stored).not.toBe(emailed);
  });

  test('confirmPasswordReset updates password when token valid and invalidates sessions', async () => {
    const pr = { id: 'pr1', userId: 'u1', expiresAt: new Date(Date.now() + 10000), usedAt: null };
    mockPrisma.passwordReset.findFirst.mockResolvedValue(pr);
    mockPrisma.user.update.mockResolvedValue({ id: 'u1' });
    mockPrisma.passwordReset.update.mockResolvedValue({});
    mockPrisma.session.deleteMany.mockResolvedValue({ count: 0 });

    await authService.confirmPasswordReset('token123', 'newpass12');

    const where = mockPrisma.passwordReset.findFirst.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ token: hashToken('token123') }, { token: 'token123' }]);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u1' } }));
    expect(mockPrisma.passwordReset.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: pr.id } }));
    // A password reset should invalidate existing sessions — otherwise a
    // stolen session token would survive the very reset meant to kill it.
    expect(mockPrisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });

  test('generate2FASecret stores secret and returns urls', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ twoFactorEnabled: false });
    mockPrisma.user.update.mockResolvedValue({});
    const out = await authService.generate2FASecret('u1');
    expect(out.base32).toBe('BASE32');
    expect(mockPrisma.user.update).toHaveBeenCalled();
  });

  test('generate2FASecret refuses to replace the secret of an account with 2FA on', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ twoFactorEnabled: true });
    await expect(authService.generate2FASecret('u1')).rejects.toMatchObject({ status: 409 });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  test('verifyAndEnable2FA verifies token and enables 2FA', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', twoFactorSecret: 'BASE32' });
    mockSpeakeasy.totp.verify.mockReturnValue(true);
    mockPrisma.user.update.mockResolvedValue({});
    await authService.verifyAndEnable2FA('u1', '123456');
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u1' }, data: { twoFactorEnabled: true } }));
  });

  test('disable2FA needs the password and a valid code, not just a session', async () => {
    const passwordHash = await bcrypt.hash('correct-horse', 4);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', twoFactorEnabled: true, twoFactorSecret: 'S', passwordHash });

    await expect(authService.disable2FA('u1', {})).rejects.toMatchObject({ status: 422 });
    await expect(authService.disable2FA('u1', { password: 'wrong', code: '123456' })).rejects.toMatchObject({ status: 401 });

    mockSpeakeasy.totp.verify.mockReturnValue(false);
    await expect(authService.disable2FA('u1', { password: 'correct-horse', code: '000000' })).rejects.toMatchObject({ status: 401 });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();

    mockSpeakeasy.totp.verify.mockReturnValue(true);
    await authService.disable2FA('u1', { password: 'correct-horse', code: '123456' });
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { twoFactorEnabled: false, twoFactorSecret: null } }));
    expect(mockPrisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });

  test('TOTP guesses are limited: five recent failures lock the check', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', twoFactorSecret: 'S' });
    mockPrisma.otpCode.count.mockResolvedValue(5);
    await expect(authService.verifyAndEnable2FA('u1', '123456')).rejects.toMatchObject({ status: 429 });
    expect(mockSpeakeasy.totp.verify).not.toHaveBeenCalled();
  });
});

describe('auth.service login timing', () => {
  beforeEach(() => jest.resetAllMocks());

  test('an unknown email still pays for a bcrypt comparison', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const spy = jest.spyOn(bcrypt, 'compare');
    await expect(authService.login({ email: 'nobody@x.nl', password: 'whatever1' })).rejects.toMatchObject({ status: 401 });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('auth.service refresh tokens', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockPrisma.businessMember.findMany.mockResolvedValue([]);
    mockPrisma.cleanerProfile.findMany.mockResolvedValue([]);
    mockPrisma.businessMember.findFirst.mockResolvedValue(null);
    mockPrisma.session.create.mockResolvedValue({});
  });
  const liveSession = { id: 's1', userId: 'u1', businessId: null, expiresAt: new Date(Date.now() + 100000) };

  test('looks the token up by hash (with legacy raw fallback) and stores new tokens hashed', async () => {
    mockPrisma.session.findFirst.mockResolvedValue(liveSession);
    mockPrisma.session.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', isActive: true, email: 'a@b.nl' });

    const result = await authService.refresh('raw-refresh');

    expect(mockPrisma.session.findFirst.mock.calls[0][0].where.OR).toEqual([
      { refreshToken: hashToken('raw-refresh') },
      { refreshToken: 'raw-refresh' },
    ]);
    const stored = mockPrisma.session.create.mock.calls[0][0].data.refreshToken;
    expect(stored).toBe(hashToken(result.refreshToken));
    expect(stored).not.toBe(result.refreshToken);
  });

  test('two concurrent refreshes with one token cannot both succeed', async () => {
    mockPrisma.session.findFirst.mockResolvedValue(liveSession);
    mockPrisma.session.deleteMany.mockResolvedValue({ count: 0 }); // the other request already consumed it
    await expect(authService.refresh('raw-refresh')).rejects.toMatchObject({ status: 401 });
    expect(mockPrisma.session.create).not.toHaveBeenCalled();
  });

  test('a deactivated user cannot refresh', async () => {
    mockPrisma.session.findFirst.mockResolvedValue(liveSession);
    mockPrisma.session.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.findUnique.mockResolvedValue({ isActive: false });
    await expect(authService.refresh('raw-refresh')).rejects.toMatchObject({ status: 401 });
  });
});

describe('auth.service email verification code', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockPrisma.otpCode.count.mockResolvedValue(0);
  });

  test('the emailed code is stored only as a salted hash and older codes are retired', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.nl' });
    await authService.requestEmailVerify('u1');
    const code = mockNotif.sendEmail.mock.calls[0][0].text.match(/\d{6}/)[0];
    expect(mockPrisma.otpCode.create.mock.calls[0][0].data.code).toBe(otpLib.hashOtp('u1', code));
    expect(mockPrisma.otpCode.updateMany).toHaveBeenCalled();
  });

  test('a wrong code is counted and the fifth failure locks confirmation', async () => {
    mockPrisma.otpCode.findFirst.mockResolvedValue(null);
    await expect(authService.confirmEmailVerify('u1', '111111')).rejects.toMatchObject({ status: 400 });
    expect(mockPrisma.otpCode.create.mock.calls[0][0].data.purpose).toBe('EMAIL_VERIFY_FAILED');

    mockPrisma.otpCode.count.mockResolvedValue(5);
    await expect(authService.confirmEmailVerify('u1', '111111')).rejects.toMatchObject({ status: 429 });
  });
});
