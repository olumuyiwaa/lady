const { planDay, planWithSavings, insertionCost, routeMeters, legMeters } = require('../src/lib/dayPlanner');

const T = (h, m = 0) => new Date(Date.UTC(2026, 10, 9, h, m));
// Amsterdam Centraal, Zuid, and Schiphol-ish (far west) ~ real coordinates
const CENTRAL = { lat: 52.3791, lng: 4.9003 };
const ZUID = { lat: 52.3389, lng: 4.8729 };
const UTRECHT = { lat: 52.0907, lng: 5.1214 };
const stop = (id, sh, eh, p) => ({ id, start: T(sh), end: T(eh), ...p });

describe('legMeters / routeMeters', () => {
  test('null without coordinates, sums consecutive legs otherwise', () => {
    expect(legMeters({ lat: null, lng: null }, CENTRAL)).toBeNull();
    const d = legMeters(CENTRAL, ZUID);
    expect(d).toBeGreaterThan(4000);
    expect(d).toBeLessThan(9000);
    expect(routeMeters([stop('a', 8, 10, CENTRAL), stop('b', 11, 13, ZUID)])).toBe(d);
    expect(routeMeters([stop('a', 8, 10, CENTRAL)])).toBe(0);
  });
});

describe('insertionCost', () => {
  const day = [stop('a', 8, 10, CENTRAL), stop('b', 14, 16, CENTRAL)];
  test('a job between two stops costs the detour only', () => {
    const c = insertionCost(day, stop('j', 11, 13, ZUID));
    expect(c.addedMeters).toBeGreaterThan(8000); // there and back to Zuid
  });
  test('overlapping an existing stop does not fit', () => {
    expect(insertionCost(day, stop('j', 9, 11, ZUID))).toBeNull();
  });
  test('not enough time to drive from the previous stop does not fit', () => {
    // Utrecht is ~35 km from Central: far more than 5 minutes
    expect(insertionCost([stop('a', 8, 10, CENTRAL)], stop('j', 10, 12, UTRECHT))).toBeNull();
    expect(insertionCost([stop('a', 8, 10, CENTRAL)], stop('j', 10, 12, ZUID))).toBeNull(); // 10 min drive needed, 0 given
    expect(insertionCost([stop('a', 8, 10, CENTRAL)], stop('j', 11, 13, ZUID))).not.toBeNull(); // an hour is plenty
  });
  test('an empty day costs nothing, a missing coordinate is flagged approximate', () => {
    expect(insertionCost([], stop('j', 9, 11, ZUID))).toEqual({ addedMeters: 0, approximate: false });
    expect(insertionCost([stop('a', 8, 9, CENTRAL)], stop('j', 12, 13, { lat: null, lng: null })).approximate).toBe(true);
  });
});

describe('planDay', () => {
  // Cleaner A already works near Central, cleaner B in Utrecht. A new job in Zuid should go to A.
  const cleaners = () => [
    { id: 'A', stops: [stop('a1', 8, 10, CENTRAL)] },
    { id: 'B', stops: [stop('b1', 8, 10, UTRECHT)] },
  ];

  test('gives each job to the cleaner it adds the least driving for', () => {
    const r = planDay(cleaners(), [stop('j1', 12, 14, ZUID)]);
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0]).toMatchObject({ bookingId: 'j1', cleanerId: 'A', alternatives: 1 });
  });

  test('later jobs see earlier planned ones (no double booking)', () => {
    const r = planDay(cleaners(), [stop('j1', 12, 14, ZUID), stop('j2', 12, 14, ZUID)]);
    expect(new Set(r.assignments.map((a) => a.cleanerId)).size).toBe(2); // only one can take the 12-14 slot near Central
  });

  test('respects availability and reports jobs nobody can take', () => {
    const r = planDay(cleaners(), [stop('j1', 12, 14, ZUID)], { isAvailable: () => false });
    expect(r.assignments).toEqual([]);
    expect(r.unassigned).toEqual([{ bookingId: 'j1', reason: 'NO_CLEANER_FITS' }]);
  });

  test('cheapest plan never drives more than first-fit, and reports the saving', () => {
    // The far cleaner (B) is listed first, so first-fit sends them to Zuid; the planner sends A.
    const [a, b] = cleaners();
    const r = planWithSavings([b, a], [stop('j1', 12, 14, ZUID)]);
    expect(r.assignments[0].cleanerId).toBe('A');
    expect(r.totalMeters).toBeLessThan(r.naiveMeters);
    expect(r.savedMeters).toBe(r.naiveMeters - r.totalMeters);
    expect(r.savedMeters).toBeGreaterThan(30000);
  });

  test('does not mutate the input', () => {
    const c = cleaners();
    planDay(c, [stop('j1', 12, 14, ZUID)]);
    expect(c[0].stops).toHaveLength(1);
  });
});
