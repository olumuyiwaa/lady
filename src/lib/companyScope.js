/**
 * Who inside a business account is asking, and which locations they may see.
 *
 * scope is null for the account holder (the Customer who logs in with their own
 * phone/email) and for staff: no restriction. For a CompanyMember it is
 * { memberId, role, locationKeys }.
 *   ADMIN           everything the company has, and manages the team
 *   BRANCH_MANAGER  bookings, reports and complaints of locationKeys only
 */
const { locationKey } = require('./b2bAccount');

const ROLES = ['ADMIN', 'BRANCH_MANAGER'];

const scopeOfMember = (m) => ({ memberId: m.id, role: m.role, locationKeys: m.role === 'ADMIN' ? [] : m.locationKeys || [] });

/** True when the scope limits what may be seen (a branch manager). */
const isRestricted = (scope) => !!scope && scope.role === 'BRANCH_MANAGER';

/** The account holder and ADMIN members. */
const isAdminScope = (scope) => !scope || scope.role === 'ADMIN';

/** Whether a booking (or anything with address fields) is inside the scope. */
function inScope(scope, booking) {
  if (!isRestricted(scope)) return true;
  return scope.locationKeys.includes(locationKey(booking));
}

const filterInScope = (scope, bookings) => (isRestricted(scope) ? bookings.filter((b) => inScope(scope, b)) : bookings);

module.exports = { ROLES, scopeOfMember, isRestricted, isAdminScope, inScope, filterInScope };
