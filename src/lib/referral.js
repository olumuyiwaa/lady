/**
 * Referral programme: "Give €20, Get €20".
 *
 * A new customer who books with a friend's code gets REFERRAL_DISCOUNT_CENTS
 * off that first booking; the friend who shared the code gets a single-use
 * coupon worth REFERRAL_REWARD_CENTS for their next booking.
 */
const REFERRAL_DISCOUNT_CENTS = 2000;
const REFERRAL_REWARD_CENTS = 2000;
const REFERRAL_REWARD_VALID_DAYS = 90;

module.exports = { REFERRAL_DISCOUNT_CENTS, REFERRAL_REWARD_CENTS, REFERRAL_REWARD_VALID_DAYS };
