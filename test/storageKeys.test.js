jest.mock('../src/config/database.js', () => ({
  cleanerProfile: { findFirst: jest.fn() },
  cleanerDocument: { create: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  user: { update: jest.fn(), findUnique: jest.fn() },
  complianceDocument: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
}));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/config/storage', () => ({
  getSignedUploadUrl: jest.fn().mockResolvedValue('https://upload'),
  getSignedDownloadUrl: jest.fn().mockResolvedValue('https://download'),
  deleteObject: jest.fn().mockResolvedValue(undefined),
  getPublicUrl: jest.fn(), getPublicUploadUrl: jest.fn().mockResolvedValue('https://public-upload'),
}));
jest.mock('../src/modules/cleaners/cleaners.service', () => ({}));
jest.mock('../src/lib/stripeClient', () => ({}));

const prisma = require('../src/config/database.js');
const storage = require('../src/config/storage');
const keys = require('../src/lib/storageKeys');
const cleanerDocs = require('../src/modules/cleanerDocuments/cleanerDocuments.service');
const cleanerSelf = require('../src/modules/cleanerSelf/cleanerSelf.service');
const compliance = require('../src/modules/compliance/compliance.service');
const businesses = require('../src/modules/businesses/businesses.service');

beforeEach(() => jest.clearAllMocks());

const cleaner = { id: 'cl1', businessId: 'bizA', userId: 'u1' };
const mine = 'businesses/bizA/cleaners/cl1/docs/1700000000000-id.pdf';
const otherTenant = 'businesses/bizB/cleaners/clX/docs/1700000000000-id.pdf';

describe('assertKeyUnderPrefix', () => {
  const prefix = 'businesses/bizA/cleaners/cl1/docs/';
  test.each([
    ['other tenant', otherTenant],
    ['sibling cleaner', 'businesses/bizA/cleaners/cl2/docs/x.pdf'],
    ['traversal', `${prefix}../../bizB/x.pdf`],
    ['double slash', `${prefix}/x.pdf`],
    ['just the prefix', prefix],
    ['not a string', 42],
    ['null', null],
    ['backslash', `${prefix}a\\b.pdf`],
    ['control char', `${prefix}a\u0000b.pdf`],
    ['too long', prefix + 'a'.repeat(600)],
  ])('rejects %s', (_n, key) => {
    expect(() => keys.assertKeyUnderPrefix(key, prefix)).toThrow(expect.objectContaining({ status: 422 }));
  });
  test('accepts a key under the prefix', () => {
    expect(keys.assertKeyUnderPrefix(mine, prefix)).toBe(mine);
  });
});

describe('assertContentType', () => {
  test('normalises case and parameters', () => {
    expect(keys.assertContentType('Image/JPEG; charset=binary', keys.IMAGE_TYPES)).toBe('image/jpeg');
  });
  test.each(['text/html', 'image/svg+xml', 'application/octet-stream', '', undefined, 'application/x-msdownload'])(
    'rejects %p', (ct) => {
      expect(() => keys.assertContentType(ct, keys.DOCUMENT_TYPES)).toThrow(expect.objectContaining({ status: 422 }));
    });
  test('public assets exclude svg and heic', () => {
    expect(keys.PUBLIC_IMAGE_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });
});

describe('cleaner self-service', () => {
  test("cannot register another tenant's object as their own document", async () => {
    await expect(cleanerSelf.createMyDocument(cleaner, { title: 'x', storageKey: otherTenant })).rejects.toMatchObject({ status: 422 });
    expect(prisma.cleanerDocument.create).not.toHaveBeenCalled();
  });
  test('can register the key they were issued', async () => {
    prisma.cleanerDocument.create.mockResolvedValue({ id: 'd1', type: 'OTHER', title: 'x' });
    await cleanerSelf.createMyDocument(cleaner, { title: 'x', storageKey: mine });
    expect(prisma.cleanerDocument.create).toHaveBeenCalled();
  });
  test('avatarKey must be under their own avatar prefix; null clears it', async () => {
    await expect(cleanerSelf.updateMyProfile(cleaner, { avatarKey: otherTenant })).rejects.toMatchObject({ status: 422 });
    await expect(cleanerSelf.updateMyProfile(cleaner, { avatarKey: 'businesses/bizA/cleaners/cl1/docs/id-card.pdf' })).rejects.toMatchObject({ status: 422 });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  test('upload URLs refuse dangerous content types and no longer default to octet-stream', async () => {
    await expect(cleanerSelf.getMyDocumentUploadUrl(cleaner, { contentType: 'text/html', filename: 'a.html' })).rejects.toMatchObject({ status: 422 });
    await expect(cleanerSelf.getMyDocumentUploadUrl(cleaner, { filename: 'a' })).rejects.toMatchObject({ status: 422 });
    const ok = await cleanerSelf.getMyDocumentUploadUrl(cleaner, { contentType: 'application/pdf', filename: 'id.pdf' });
    expect(ok.storageKey.startsWith('businesses/bizA/cleaners/cl1/docs/')).toBe(true);
    await expect(cleanerSelf.getMyAvatarUploadUrl(cleaner, { contentType: 'image/svg+xml' })).rejects.toMatchObject({ status: 422 });
  });
});

describe('admin cleaner documents', () => {
  test('createDocument rejects a key from another cleaner or tenant', async () => {
    prisma.cleanerProfile.findFirst.mockResolvedValue({ id: 'cl1' });
    await expect(cleanerDocs.createDocument('bizA', 'u', { cleanerId: 'cl1', title: 't', storageKey: otherTenant })).rejects.toMatchObject({ status: 422 });
    expect(prisma.cleanerDocument.create).not.toHaveBeenCalled();
  });
  test('deleteDocument never deletes an object outside the tenant, even if the row points there', async () => {
    prisma.cleanerDocument.findFirst.mockResolvedValue({ id: 'd1', businessId: 'bizA', cleanerId: 'cl1', title: 't', storageKey: otherTenant });
    await cleanerDocs.deleteDocument('bizA', 'd1', 'u');
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(prisma.cleanerDocument.delete).toHaveBeenCalled();
  });
  test('deleteDocument deletes the object when it is inside the tenant', async () => {
    prisma.cleanerDocument.findFirst.mockResolvedValue({ id: 'd1', businessId: 'bizA', cleanerId: 'cl1', title: 't', storageKey: mine });
    await cleanerDocs.deleteDocument('bizA', 'd1', 'u');
    expect(storage.deleteObject).toHaveBeenCalledWith(mine);
  });
});

describe('compliance documents', () => {
  test('placeholder / foreign keys are rejected; server-issued ones accepted', async () => {
    await expect(compliance.createDocument('bizA', { title: 't', storageKey: 'placeholder' }, 'u')).rejects.toMatchObject({ status: 422 });
    await expect(compliance.createDocument('bizA', { title: 't', storageKey: 'businesses/bizB/compliance/1-x.pdf' }, 'u')).rejects.toMatchObject({ status: 422 });
    const { storageKey } = await compliance.getUploadUrl('bizA', { contentType: 'application/pdf', filename: 'sds.pdf' });
    prisma.complianceDocument.create.mockResolvedValue({ id: 'c1' });
    await compliance.createDocument('bizA', { title: 't', storageKey }, 'u');
    expect(prisma.complianceDocument.create).toHaveBeenCalledTimes(1);
  });
});

describe('branding assets', () => {
  test('public upload only accepts inert image types', async () => {
    await expect(businesses.brandingUploadUrl('bizA', { kind: 'logo', filename: 'x.svg', contentType: 'image/svg+xml' })).rejects.toMatchObject({ status: 422 });
    await expect(businesses.brandingUploadUrl('bizA', { kind: 'logo', filename: 'x.html', contentType: 'text/html' })).rejects.toMatchObject({ status: 422 });
    await expect(businesses.brandingUploadUrl('bizA', { kind: 'logo', filename: 'x.png', contentType: 'image/png' })).resolves.toHaveProperty('uploadUrl');
  });
});
