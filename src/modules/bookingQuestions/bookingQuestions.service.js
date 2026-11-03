const prisma = require('../../config/database');

const TYPES = ['TEXT', 'LONG_TEXT', 'SELECT', 'MULTI_SELECT', 'YES_NO', 'NUMBER'];
const CHOICE_TYPES = ['SELECT', 'MULTI_SELECT'];
const MAX_QUESTIONS_PER_BUSINESS = 20;
const LIMITS = { label: 200, helpText: 300, option: 100, text: 500, longText: 2000, minOptions: 2, maxOptions: 20 };

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** Questions shown for this service: active, and either for all services or this one. */
function applicableTo(questions, serviceId) {
  return questions
    .filter((q) => q.isActive !== false && (!q.serviceIds || q.serviceIds.length === 0 || q.serviceIds.includes(serviceId)))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Validates one answer against its question; returns the cleaned value. */
function cleanValue(q, v) {
  switch (q.type) {
    case 'TEXT':
    case 'LONG_TEXT': {
      if (typeof v !== 'string') throw httpError(422, `Invalid answer for: ${q.label}`);
      const max = q.type === 'TEXT' ? LIMITS.text : LIMITS.longText;
      const t = v.trim();
      if (t.length > max) throw httpError(422, `Answer too long for: ${q.label}`);
      return t;
    }
    case 'SELECT':
      if (typeof v !== 'string' || !q.options.includes(v)) throw httpError(422, `Invalid choice for: ${q.label}`);
      return v;
    case 'MULTI_SELECT': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !q.options.includes(x))) {
        throw httpError(422, `Invalid choice for: ${q.label}`);
      }
      return [...new Set(v)];
    }
    case 'YES_NO':
      if (typeof v !== 'boolean') throw httpError(422, `Invalid answer for: ${q.label}`);
      return v;
    case 'NUMBER': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n) || Math.abs(n) > 1e9) throw httpError(422, `Invalid number for: ${q.label}`);
      return n;
    }
    default:
      throw httpError(422, `Unsupported question type: ${q.type}`);
  }
}

/**
 * Turns the customer's raw answers into the snapshot stored on the booking.
 * Rejects answers to questions that are not asked for this service (or belong
 * to another business), enforces required questions, and validates each value
 * against its type. The snapshot carries the question text, so it stays correct
 * if the question is edited or deleted later.
 */
function resolveAnswers(questions, serviceId, raw) {
  const asked = applicableTo(questions, serviceId);
  const askedIds = new Set(asked.map((q) => q.id));
  const given = new Map();

  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) throw httpError(422, 'answers must be a list');
    if (raw.length > MAX_QUESTIONS_PER_BUSINESS * 2) throw httpError(422, 'Too many answers');
    for (const a of raw) {
      if (!a || typeof a.questionId !== 'string') throw httpError(422, 'Invalid answer');
      if (!askedIds.has(a.questionId)) throw httpError(422, 'Answer for a question that is not asked');
      given.set(a.questionId, a.value);
    }
  }

  const out = [];
  for (const q of asked) {
    const v = given.get(q.id);
    if (isEmpty(v)) {
      if (q.required) throw httpError(422, `Please answer: ${q.label}`);
      continue;
    }
    out.push({ questionId: q.id, label: q.label, type: q.type, value: cleanValue(q, v) });
  }
  return out;
}

/** Validates and normalises the fields of a question being created or edited. */
async function cleanQuestionInput(businessId, input, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (!partial || has('label')) {
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!label || label.length > LIMITS.label) throw httpError(422, `label is required (max ${LIMITS.label} characters)`);
    out.label = label;
  }
  if (has('helpText')) {
    const h = input.helpText == null ? '' : String(input.helpText).trim();
    if (h.length > LIMITS.helpText) throw httpError(422, `helpText is too long (max ${LIMITS.helpText})`);
    out.helpText = h || null;
  }
  if (!partial || has('type')) {
    if (!TYPES.includes(input.type)) throw httpError(422, `type must be one of ${TYPES.join(', ')}`);
    out.type = input.type;
  }
  if (has('required')) out.required = Boolean(input.required);
  if (has('isActive')) out.isActive = Boolean(input.isActive);
  if (has('sortOrder')) {
    if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 1000) throw httpError(422, 'sortOrder must be a whole number');
    out.sortOrder = input.sortOrder;
  }
  if (has('serviceIds')) {
    if (!Array.isArray(input.serviceIds) || input.serviceIds.some((s) => typeof s !== 'string')) throw httpError(422, 'serviceIds must be a list');
    const ids = [...new Set(input.serviceIds)];
    if (ids.length) {
      const count = await prisma.service.count({ where: { id: { in: ids }, businessId } });
      if (count !== ids.length) throw httpError(422, 'Unknown service');
    }
    out.serviceIds = ids;
  }
  return out;
}

function cleanOptions(type, options) {
  if (!CHOICE_TYPES.includes(type)) return [];
  const list = Array.isArray(options) ? options.map((o) => (typeof o === 'string' ? o.trim() : '')).filter(Boolean) : [];
  const unique = [...new Set(list)];
  if (unique.length < LIMITS.minOptions || unique.length > LIMITS.maxOptions) {
    throw httpError(422, `Provide ${LIMITS.minOptions} to ${LIMITS.maxOptions} different options`);
  }
  if (unique.some((o) => o.length > LIMITS.option)) throw httpError(422, `Each option can be at most ${LIMITS.option} characters`);
  return unique;
}

async function list(businessId) {
  return prisma.bookingQuestion.findMany({ where: { businessId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
}

async function create(businessId, input) {
  const count = await prisma.bookingQuestion.count({ where: { businessId } });
  if (count >= MAX_QUESTIONS_PER_BUSINESS) throw httpError(422, `You can add at most ${MAX_QUESTIONS_PER_BUSINESS} questions`);
  const data = await cleanQuestionInput(businessId, input);
  data.options = cleanOptions(data.type, input.options);
  if (data.sortOrder === undefined) data.sortOrder = count;
  return prisma.bookingQuestion.create({ data: { businessId, ...data } });
}

async function update(businessId, id, input) {
  const existing = await prisma.bookingQuestion.findFirst({ where: { id, businessId } });
  if (!existing) throw httpError(404, 'Question not found');
  const data = await cleanQuestionInput(businessId, input, { partial: true });
  const type = data.type || existing.type;
  if (data.type !== undefined || Object.prototype.hasOwnProperty.call(input, 'options')) {
    data.options = cleanOptions(type, Object.prototype.hasOwnProperty.call(input, 'options') ? input.options : existing.options);
  }
  return prisma.bookingQuestion.update({ where: { id }, data });
}

async function remove(businessId, id) {
  const existing = await prisma.bookingQuestion.findFirst({ where: { id, businessId } });
  if (!existing) throw httpError(404, 'Question not found');
  await prisma.bookingQuestion.delete({ where: { id } });
}

/** What the public booking form needs: no business internals. */
async function listPublic(businessId) {
  const rows = await prisma.bookingQuestion.findMany({
    where: { businessId, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((q) => ({
    id: q.id,
    label: q.label,
    helpText: q.helpText,
    type: q.type,
    options: q.options,
    required: q.required,
    serviceIds: q.serviceIds,
  }));
}

/** Loads the business's active questions and validates the answers for one booking. */
async function resolveForBooking(businessId, serviceId, raw) {
  const questions = await prisma.bookingQuestion.findMany({ where: { businessId, isActive: true } });
  return resolveAnswers(questions, serviceId, raw);
}

module.exports = {
  list, create, update, remove, listPublic, resolveForBooking,
  resolveAnswers, applicableTo, MAX_QUESTIONS_PER_BUSINESS, TYPES,
};
