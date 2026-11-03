const { amountDueCents, jobPaymentCents, paidSoFarCents, buildRefundPlan } = require('../src/lib/paymentMath');

describe('paymentMath', () => {
  const base = { quotedPriceCents: 10000, giftCardAppliedCents: null, depositRequiredCents: null, depositPaidAt: null, amountPaidCents: null, paymentStatus: 'UNPAID' };

  test('an untouched booking owes the full quote', () => {
    expect(amountDueCents(base)).toBe(10000);
  });

  test('a paid deposit and a gift card reduce what is owed (no double charge)', () => {
    const b = { ...base, depositRequiredCents: 2000, depositPaidAt: new Date(), giftCardAppliedCents: 3000 };
    expect(amountDueCents(b)).toBe(5000);
  });

  test('part-payments recorded by hand reduce what is owed', () => {
    expect(amountDueCents({ ...base, paymentStatus: 'PARTIAL', amountPaidCents: 4000 })).toBe(6000);
  });

  test('never negative', () => {
    expect(amountDueCents({ ...base, giftCardAppliedCents: 20000 })).toBe(0);
  });

  test('a booking marked PAID before amounts were tracked counts as having paid what was due', () => {
    const b = { ...base, paymentStatus: 'PAID', depositRequiredCents: 2000, depositPaidAt: new Date() };
    expect(jobPaymentCents(b)).toBe(8000);
    expect(paidSoFarCents(b)).toBe(10000);
  });

  test('refund plan splits across intents without exceeding either charge', () => {
    const b = { ...base, paymentStatus: 'PAID', amountPaidCents: 8000, stripePaymentIntentId: 'pi_job', depositRequiredCents: 2000, depositPaidAt: new Date(), stripeDepositPaymentIntentId: 'pi_dep' };
    expect(buildRefundPlan(b, 10000)).toEqual({ items: [{ paymentIntentId: 'pi_job', amountCents: 8000 }, { paymentIntentId: 'pi_dep', amountCents: 2000 }], manualCents: 0 });
    expect(buildRefundPlan(b, 5000)).toEqual({ items: [{ paymentIntentId: 'pi_job', amountCents: 5000 }], manualCents: 0 });
  });

  test('cash payments cannot be refunded through Stripe and come back as manualCents', () => {
    const b = { ...base, paymentStatus: 'PAID', amountPaidCents: 6000 };
    expect(buildRefundPlan(b, 6000)).toEqual({ items: [], manualCents: 6000 });
  });
});
