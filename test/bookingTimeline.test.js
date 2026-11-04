const { buildTimeline } = require('../src/lib/bookingTimeline');

const T = (h) => new Date(`2026-11-05T${String(h).padStart(2, '0')}:00:00Z`);
const keys = (tl) => tl.steps.map((s) => `${s.key}:${s.state}`);

describe('buildTimeline', () => {
  test('a new request has only BOOKED done and CONFIRMED current', () => {
    const tl = buildTimeline({ status: 'REQUESTED', createdAt: T(8) }, []);
    expect(keys(tl)).toEqual([
      'BOOKED:done', 'CONFIRMED:current', 'CLEANER_ASSIGNED:upcoming',
      'ON_THE_WAY:upcoming', 'ARRIVED:upcoming', 'COMPLETED:upcoming',
    ]);
    expect(tl.current).toBe('CONFIRMED');
  });

  test('assigned booking: next step is the cleaner heading over', () => {
    const tl = buildTimeline(
      { status: 'ASSIGNED', createdAt: T(8) },
      [{ assignedAt: T(9) }],
      { confirmedAt: T(8.5 | 0) }
    );
    expect(tl.current).toBe('ON_THE_WAY');
    expect(tl.steps.find((s) => s.key === 'CLEANER_ASSIGNED')).toMatchObject({ state: 'done', at: T(9) });
  });

  test('on my way and arrived are timed from the assignment', () => {
    const tl = buildTimeline(
      { status: 'IN_PROGRESS', createdAt: T(8) },
      [{ assignedAt: T(9), onMyWayAt: T(10), checkedInAt: T(11) }]
    );
    expect(tl.steps.find((s) => s.key === 'ON_THE_WAY').at).toEqual(T(10));
    expect(tl.steps.find((s) => s.key === 'ARRIVED').at).toEqual(T(11));
    expect(tl.current).toBe('COMPLETED');
  });

  test('completed booking has every step done and ends on COMPLETED', () => {
    const tl = buildTimeline(
      { status: 'COMPLETED', createdAt: T(8), updatedAt: T(14) },
      [{ assignedAt: T(9), onMyWayAt: T(10), checkedInAt: T(11), checkedOutAt: T(13) }]
    );
    expect(tl.steps.every((s) => s.state === 'done')).toBe(true);
    expect(tl.steps[tl.steps.length - 1]).toMatchObject({ key: 'COMPLETED', at: T(13) });
    expect(tl.current).toBe('COMPLETED');
  });

  test('a step that happened without a recorded time is done with a null time', () => {
    const tl = buildTimeline({ status: 'CONFIRMED', createdAt: T(8) }, []);
    expect(tl.steps.find((s) => s.key === 'CONFIRMED')).toMatchObject({ state: 'done', at: null });
  });

  test('cancelled before anyone was assigned shows only what happened, then CANCELLED', () => {
    const tl = buildTimeline({ status: 'CANCELLED', createdAt: T(8), updatedAt: T(9) }, []);
    expect(keys(tl)).toEqual(['BOOKED:done', 'CANCELLED:done']);
    expect(tl.current).toBe('CANCELLED');
  });

  test('cancelled after a cleaner was assigned keeps the assignment step', () => {
    const tl = buildTimeline({ status: 'CANCELLED', createdAt: T(8), updatedAt: T(12) }, [{ assignedAt: T(9) }]);
    expect(keys(tl)).toEqual(['BOOKED:done', 'CONFIRMED:done', 'CLEANER_ASSIGNED:done', 'CANCELLED:done']);
  });

  test('with several cleaners, the earliest on-my-way and latest checkout are used', () => {
    const tl = buildTimeline(
      { status: 'COMPLETED', createdAt: T(8), updatedAt: T(15) },
      [
        { assignedAt: T(9), onMyWayAt: T(10), checkedInAt: T(11), checkedOutAt: T(13) },
        { assignedAt: T(9), onMyWayAt: T(9.5 | 0), checkedInAt: T(12), checkedOutAt: T(14) },
      ]
    );
    expect(tl.steps.find((s) => s.key === 'ON_THE_WAY').at).toEqual(T(9));
    expect(tl.steps.find((s) => s.key === 'ARRIVED').at).toEqual(T(11));
    expect(tl.steps.find((s) => s.key === 'COMPLETED').at).toEqual(T(14));
  });
});
