const b = require('../src/modules/transactions/transactions.builders');

const booking = (over = {}) => ({
  id: 'ckabcdef123456', businessId: 'biz1', customerId: 'cust1',
  customer: { firstName: 'Anna', lastName: 'de Vries' },
  quotedPriceCents: 10000, giftCardAppliedCents: null,
  depositRequiredCents: null, depositPaidAt: null,
  amountPaidCents: null, paymentStatus: 'UNPAID', stripePaymentIntentId: null,
  tipAmountCents: null, tipPaidAt: null, refundedAmountCents: null, refundedAt: null, stripeRefundId: null,
  createdAt: new Date('2026-01-01T10:00:00Z'), updatedAt: new Date('2026-01-05T10:00:00Z'),
  ...over,
});

describe('event builders', () => {
  test('every customer payment is money IN, positive, tied to the booking and customer', () => {
    const rows = [
      b.jobPaymentStripe({ booking: booking(), sessionId: 'cs_1', paymentIntentId: 'pi_1', amountCents: 5000, currency: 'eur' }),
      b.deposit({ booking: booking(), sessionId: 'cs_2', paymentIntentId: 'pi_2', amountCents: 2000, currency: 'eur' }),
      b.tip({ booking: booking(), sessionId: 'cs_3', paymentIntentId: 'pi_3', amountCents: 500, currency: 'eur' }),
    ];
    for (const r of rows) {
      expect(r).toMatchObject({ direction: 'IN', status: 'SUCCEEDED', method: 'STRIPE', businessId: 'biz1', bookingId: 'ckabcdef123456', customerId: 'cust1', currency: 'EUR', counterpartyName: 'Anna de Vries' });
    }
    expect(rows.map((r) => r.type)).toEqual(['BOOKING_PAYMENT', 'DEPOSIT', 'TIP']);
  });

  test('the dedupe key comes from the event identity, never a timestamp', () => {
    const a = b.deposit({ booking: booking(), sessionId: 'cs_1', amountCents: 1, occurredAt: new Date('2026-01-01') });
    const c = b.deposit({ booking: booking(), sessionId: 'cs_1', amountCents: 1, occurredAt: new Date('2030-06-06') });
    expect(a.dedupeKey).toBe(c.dedupeKey);
    expect(b.jobPaymentStripe({ booking: booking(), sessionId: 'cs_9', amountCents: 1 }).dedupeKey).toBe('jobpay:stripe:cs_9');
    expect(b.tip({ booking: booking(), amountCents: 1 }).dedupeKey).toBe('tip:ckabcdef123456');
  });

  test('a duplicate tip gets its own key so it cannot collide with the real tip', () => {
    const real = b.tip({ booking: booking(), sessionId: 'cs_a', amountCents: 500 });
    const dup = b.tip({ booking: booking(), sessionId: 'cs_b', amountCents: 500, duplicate: true });
    expect(dup.dedupeKey).toBe('tip:dup:cs_b');
    expect(dup.dedupeKey).not.toBe(real.dedupeKey);
    expect(dup.metadata).toMatchObject({ duplicate: true });
  });

  test('hand-recorded payments are unique per call (part-payments are legitimate)', () => {
    const one = b.jobPaymentManual({ booking: booking(), method: 'CASH', amountCents: 4000 });
    const two = b.jobPaymentManual({ booking: booking(), method: 'CASH', amountCents: 4000 });
    expect(one.dedupeKey).not.toBe(two.dedupeKey);
    expect(one).toMatchObject({ method: 'CASH', direction: 'IN' });
  });

  test('manual method names map to the log enum, anything unknown is OTHER', () => {
    const m = (method) => b.jobPaymentManual({ booking: booking(), method, amountCents: 1 }).method;
    expect([m('CASH'), m('BANK_TRANSFER'), m('INVOICE'), m('OTHER'), m('cheque')]).toEqual(['CASH', 'BANK_TRANSFER', 'INVOICE', 'OTHER', 'OTHER']);
  });

  test('manual reference and note are length-limited', () => {
    const r = b.jobPaymentManual({ booking: booking(), method: 'CASH', amountCents: 1, reference: 'x'.repeat(500), note: 'y'.repeat(500) });
    expect(r.reference).toHaveLength(120);
    expect(r.metadata.note).toHaveLength(200);
  });

  test('a refund is OUT and shares its key with the Stripe refund id', () => {
    const r = b.refund({ booking: booking(), refundId: 're_1', paymentIntentId: 'pi_1', amountCents: 3000, reason: 'cancellation', cancellationFeeCents: 1000 });
    expect(r).toMatchObject({ type: 'REFUND', direction: 'OUT', dedupeKey: 'refund:re_1', stripeRefundId: 're_1' });
    expect(r.metadata).toEqual({ reason: 'cancellation', cancellationFeeCents: 1000 });
  });

  test.each([
    ['needs_response', 'PENDING'], ['under_review', 'PENDING'], ['warning_needs_response', 'PENDING'],
    ['won', 'REVERSED'], ['warning_closed', 'REVERSED'], ['lost', 'SUCCEEDED'],
  ])('dispute status %s -> %s', (stripe, ours) => {
    expect(b.disputeStatus(stripe)).toBe(ours);
    expect(b.dispute({ booking: booking(), disputeId: 'dp_1', amountCents: 1, stripeStatus: stripe }).status).toBe(ours);
  });

  test('payout methods map to the log enum and the payout id is the key', () => {
    const p = (method) => b.cleanerPayout({ payout: { id: 'po1', businessId: 'biz1', cleanerId: 'c1', totalCents: 9000, method, paidAt: new Date('2026-02-01') }, cleanerName: 'Ada' });
    expect(['STRIPE', 'MANUAL_CASH', 'MANUAL_TRANSFER', 'OTHER', null].map((m) => p(m).method)).toEqual(['STRIPE', 'CASH', 'BANK_TRANSFER', 'OTHER', 'OTHER']);
    expect(p('STRIPE')).toMatchObject({ type: 'CLEANER_PAYOUT', direction: 'OUT', dedupeKey: 'payout:po1', counterpartyName: 'Ada', occurredAt: new Date('2026-02-01') });
  });

  test('a subscription invoice is OUT for the business, FAILED unless paid', () => {
    const ok = b.subscriptionInvoice({ businessId: 'biz1', invoiceId: 'in_1', amountCents: 2900, currency: 'eur', paid: true });
    const bad = b.subscriptionInvoice({ businessId: 'biz1', invoiceId: 'in_1', amountCents: 2900, currency: 'eur', paid: false });
    expect(ok).toMatchObject({ type: 'SUBSCRIPTION', direction: 'OUT', status: 'SUCCEEDED', counterpartyName: 'Tod Cleaning Services' });
    expect(bad.status).toBe('FAILED');
    expect(ok.dedupeKey).toBe(bad.dedupeKey); // same invoice, one row
  });

  test('an unknown currency stays null so the service uses the business currency, not a hard-coded EUR', () => {
    expect(b.deposit({ booking: booking(), amountCents: 1 }).currency).toBeNull();
    expect(b.deposit({ booking: booking({ business: { currency: 'gbp' } }), amountCents: 1 }).currency).toBe('GBP');
  });
});

describe('rowsFromBooking (backfill)', () => {
  const keys = (rows) => rows.map((r) => r.dedupeKey);

  test('an unpaid booking produces nothing', () => {
    expect(b.rowsFromBooking(booking())).toEqual([]);
  });

  test('deposit, job payment and tip are separate rows and the deposit is not counted twice', () => {
    const rows = b.rowsFromBooking(booking({
      depositRequiredCents: 2000, depositPaidAt: new Date('2026-01-02'), stripeDepositPaymentIntentId: 'pi_dep',
      amountPaidCents: 8000, stripePaymentIntentId: 'pi_job', paymentStatus: 'PAID',
      tipAmountCents: 500, tipPaidAt: new Date('2026-01-06'), stripeTipPaymentIntentId: 'pi_tip',
    }));
    const by = Object.fromEntries(rows.map((r) => [r.type, r]));
    expect(by.DEPOSIT.amountCents).toBe(2000);
    expect(by.BOOKING_PAYMENT.amountCents).toBe(8000); // job only: the deposit is its own row
    expect(by.TIP.amountCents).toBe(500);
    expect(rows.every((r) => r.backfilled === true && r.direction === 'IN')).toBe(true);
    expect(rows.reduce((n, r) => n + r.amountCents, 0)).toBe(10500);
  });

  test('a booking marked PAID by hand before amountPaidCents existed is still recovered', () => {
    const rows = b.rowsFromBooking(booking({ paymentStatus: 'PAID', amountPaidCents: null, quotedPriceCents: 10000, depositRequiredCents: 2000, depositPaidAt: new Date('2026-01-02') }));
    const job = rows.find((r) => r.type === 'BOOKING_PAYMENT');
    expect(job.amountCents).toBe(8000); // quote - deposit
    expect(job.metadata).toMatchObject({ dateApproximate: true });
  });

  test('gift card value is not cash and is not recorded as money received', () => {
    const rows = b.rowsFromBooking(booking({ paymentStatus: 'PAID', quotedPriceCents: 10000, giftCardAppliedCents: 4000 }));
    expect(rows.find((r) => r.type === 'BOOKING_PAYMENT').amountCents).toBe(6000);
  });

  test('the job payment date is the best available guess and says so', () => {
    const withInvoice = b.rowsFromBooking({ ...booking({ amountPaidCents: 5000 }), paidAtGuess: new Date('2026-01-09') })[0];
    const without = b.rowsFromBooking(booking({ amountPaidCents: 5000 }))[0];
    expect(withInvoice.occurredAt).toEqual(new Date('2026-01-09'));
    expect(without.occurredAt).toEqual(new Date('2026-01-05T10:00:00Z')); // updatedAt
    expect(without.metadata.dateApproximate).toBe(true);
  });

  test('a single refund shares its key with the live webhook, several become one approximate row', () => {
    const one = b.rowsFromBooking(booking({ refundedAmountCents: 3000, refundedAt: new Date('2026-01-07'), stripeRefundId: 're_1' }));
    expect(keys(one)).toEqual(['refund:re_1']);
    const many = b.rowsFromBooking(booking({ refundedAmountCents: 5000, refundedAt: new Date('2026-01-07'), stripeRefundId: 're_1,re_2' }));
    expect(keys(many)).toEqual(['refund:backfill:ckabcdef123456']);
    expect(many[0].metadata).toMatchObject({ combined: true, refundIds: ['re_1', 're_2'] });
    expect(many[0].stripeRefundId).toBeNull();
  });

  test('backfill keys are deterministic, so a second run inserts nothing new', () => {
    const input = booking({ depositRequiredCents: 2000, depositPaidAt: new Date('2026-01-02'), amountPaidCents: 8000 });
    expect(keys(b.rowsFromBooking(input))).toEqual(keys(b.rowsFromBooking(input)));
  });

  test('payout and platform-invoice rows are backfilled and flagged', () => {
    const p = b.rowFromPayout({ id: 'po1', businessId: 'biz1', cleanerId: 'c1', totalCents: 9000, method: 'MANUAL_CASH', paidAt: new Date('2026-02-01') }, { cleanerName: 'Ada', currency: 'eur' });
    expect(p).toMatchObject({ backfilled: true, method: 'CASH', currency: 'EUR', amountCents: 9000 });
    const paid = b.rowFromPlatformInvoice({ id: 'pi1', stripeInvoiceId: 'in_1', amountCents: 2900, status: 'paid', paidAt: new Date('2026-02-02'), issuedAt: new Date('2026-02-01') }, { businessId: 'biz1', currency: 'eur' });
    const open = b.rowFromPlatformInvoice({ id: 'pi2', stripeInvoiceId: 'in_2', amountCents: 2900, status: 'open', issuedAt: new Date('2026-03-01') }, { businessId: 'biz1', currency: 'eur' });
    expect(paid).toMatchObject({ status: 'SUCCEEDED', occurredAt: new Date('2026-02-02'), backfilled: true });
    expect(open).toMatchObject({ status: 'FAILED', occurredAt: new Date('2026-03-01') });
  });
});
