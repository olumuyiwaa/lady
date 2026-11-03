'use strict';

const { z } = require('zod');

const inventoryItemType = z.enum(['SUPPLY', 'CHEMICAL', 'EQUIPMENT', 'PPE', 'OTHER']);
const stockMovementType = z.enum(['PURCHASE', 'ADJUSTMENT', 'USAGE', 'TRANSFER', 'RETURN', 'WRITE_OFF']);

const createItemSchema = z.object({
  name: z.string().min(1).max(200),
  sku: z.string().max(80).optional().nullable(),
  type: inventoryItemType.default('SUPPLY'),
  description: z.string().max(2000).optional().nullable(),
  unit: z.string().max(40).default('each'),
  reorderPoint: z.number().int().min(0).optional().nullable(),
  reorderQuantity: z.number().int().min(0).optional().nullable(),
  isHazardous: z.boolean().default(false),
  manufacturer: z.string().max(200).optional().nullable(),
  casNumber: z.string().max(80).optional().nullable(),
  hazardClass: z.string().max(120).optional().nullable(),
  sdsId: z.string().cuid().optional().nullable(),
});

const updateItemSchema = createItemSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const createLocationSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['WAREHOUSE', 'VEHICLE', 'SITE']).default('WAREHOUSE'),
  address: z.string().max(500).optional().nullable(),
});

const updateLocationSchema = createLocationSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const createMovementSchema = z.object({
  itemId: z.string().cuid(),
  type: stockMovementType,
  quantity: z.number().int().positive(),
  fromLocationId: z.string().cuid().optional().nullable(),
  toLocationId: z.string().cuid().optional().nullable(),
  bookingId: z.string().cuid().optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

const jobUsageSchema = z.object({
  itemId: z.string().cuid(),
  quantity: z.number().int().positive(),
  notes: z.string().max(500).optional().nullable(),
  locationId: z.string().cuid().optional().nullable(), // which stock location to decrement
});

module.exports = {
  createItemSchema,
  updateItemSchema,
  createLocationSchema,
  updateLocationSchema,
  createMovementSchema,
  jobUsageSchema,
};
