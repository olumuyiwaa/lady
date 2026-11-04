/**
 * Covers the gift card gap: Tod Cleaning Services had no stored-value gift card at
 * all — only single-rule Coupon discounts, which can't express "$50 was
 * on this card, $20 was spent, $30 remains for next time". applyGiftCardToBooking
 * is the redemption half (checkGiftCardBalance is the read-only preview,
 * covered indirectly here too).
 */
jest.mock('../src/config/database.js', () => ({
  giftCard: { findFirst: jest.fn(), updateMany: jest.fn() },
  booking: { update: jest.fn() },
}));

const mockPrisma = require('../src/config/database.js');
const { applyGiftCardToBooking, checkGiftCardBalance } = require('../src/modules/widget/widget.service');

describe('widget.service.applyGiftCardToBooking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const booking = { id: 'bk1', quotedPriceCents: 15000 };

  test('returns null and does nothing when no code is given', async () => {
    const result = await applyGiftCardToBooking('biz1', booking, undefined);
    expect(result).toBeNull();
    expect(mockPrisma.giftCard.findFirst).not.toHaveBeenCalled();
  });

  test('returns null for a code that does not exist', async () => {
    mockPrisma.giftCard.findFirst.mockResolvedValue(null);
    const result = await applyGiftCardToBooking('biz1', booking, 'NOPE');
    expect(result).toBeNull();
    expect(mockPrisma.giftCard.updateMany).not.toHaveBeenCalled();
  });

  test('returns null for an expired card', async () => {
    mockPrisma.giftCard.findFirst.mockResolvedValue({
      id: 'gc1',
      balanceCents: 5000,
      purchasePaidAt: new Date(),
      expiresAt: new Date(Date.now() - 1000),
    });
    const result = await applyGiftCardToBooking('biz1', booking, 'GC-OLD');
    expect(result).toBeNull();
  });

  test('applies min(balance, amountDue) and decrements the balance atomically', async () => {
    mockPrisma.giftCard.findFirst.mockResolvedValue({
      id: 'gc1',
      balanceCents: 5000, // less than the $150 booking
      purchasePaidAt: new Date(),
      expiresAt: null,
    });
    mockPrisma.giftCard.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.booking.update.mockResolvedValue({});

    const result = await applyGiftCardToBooking('biz1', booking, 'gc-abc123');

    expect(mockPrisma.giftCard.updateMany).toHaveBeenCalledWith({
      where: { id: 'gc1', balanceCents: { gte: 5000 } },
      data: { balanceCents: { decrement: 5000 } },
    });
    expect(mockPrisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'bk1' },
      data: { giftCardId: 'gc1', giftCardAppliedCents: 5000 },
    });
    expect(result).toEqual({ giftCardId: 'gc1', appliedCents: 5000 });
  });

  test('caps the applied amount at what the booking actually costs', async () => {
    mockPrisma.giftCard.findFirst.mockResolvedValue({
      id: 'gc1',
      balanceCents: 50000, // way more than the $150 booking
      purchasePaidAt: new Date(),
      expiresAt: null,
    });
    mockPrisma.giftCard.updateMany.mockResolvedValue({ count: 1 });

    const result = await applyGiftCardToBooking('biz1', booking, 'GC-BIG');

    expect(mockPrisma.giftCard.updateMany).toHaveBeenCalledWith({
      where: { id: 'gc1', balanceCents: { gte: 15000 } },
      data: { balanceCents: { decrement: 15000 } },
    });
    expect(result.appliedCents).toBe(15000);
  });

  test('does not double-spend when a concurrent redemption already drained the balance', async () => {
    mockPrisma.giftCard.findFirst.mockResolvedValue({
      id: 'gc1',
      balanceCents: 5000,
      purchasePaidAt: new Date(),
      expiresAt: null,
    });
    // Simulates losing the race: another request's updateMany already
    // dropped the balance below what this one expected to find.
    mockPrisma.giftCard.updateMany.mockResolvedValue({ count: 0 });

    const result = await applyGiftCardToBooking('biz1', booking, 'GC-RACE');

    expect(result).toBeNull();
    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
  });

  test('a card that has not been paid for yet cannot be redeemed', async () => {
    mockPrisma.giftCard.findFirst.mockResolvedValue({
      id: 'gc1',
      balanceCents: 5000,
      purchasePaidAt: null,
      expiresAt: null,
    });
    const result = await applyGiftCardToBooking('biz1', booking, 'GC-UNPAID');
    expect(result).toBeNull();
  });
});

describe('widget.service.checkGiftCardBalance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reports a valid card with its balance, and nothing else', async () => {
    mockPrisma.giftCard.findFirst.mockResolvedValue({
      balanceCents: 4200,
      purchasePaidAt: new Date(),
      expiresAt: null,
      recipientEmail: 'someone@example.com', // must not leak into the response
    });
    const result = await checkGiftCardBalance('biz1', 'gc-xyz');
    expect(result).toEqual({ valid: true, balanceCents: 4200 });
  });

  test('reports zero-balance cards as invalid', async () => {
    mockPrisma.giftCard.findFirst.mockResolvedValue({
      balanceCents: 0,
      purchasePaidAt: new Date(),
      expiresAt: null,
    });
    const result = await checkGiftCardBalance('biz1', 'GC-SPENT');
    expect(result).toEqual({ valid: false, reason: 'zero_balance' });
  });
});
