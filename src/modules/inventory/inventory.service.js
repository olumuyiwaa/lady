'use strict';

// Was: const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient();
// That created a second, independent PrismaClient (and connection pool)
// alongside the shared one every other module uses -- fine at low volume,
// but each instantiation opens its own pool against Postgres, and enough
// of them across modules risks exhausting the database's connection
// limit under load. Use the shared singleton like everything else does.
const prisma = require('../../config/database');

class InventoryService {
  // ─── Items ───────────────────────────────────────────────

  async listItems(businessId, { type, isActive, search, page = 1, limit = 50 } = {}) {
    const where = { businessId };
    if (type) where.type = type;
    if (typeof isActive === 'boolean') where.isActive = isActive;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.inventoryItem.findMany({
        where,
        include: {
          sds: { select: { id: true, title: true, version: true, expiresAt: true } },
          stockLevels: {
            include: { location: { select: { id: true, name: true, type: true } } },
          },
        },
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.inventoryItem.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async getItem(businessId, itemId) {
    return prisma.inventoryItem.findFirst({
      where: { id: itemId, businessId },
      include: {
        sds: true,
        stockLevels: { include: { location: true } },
        movements: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
  }

  async createItem(businessId, data) {
    return prisma.inventoryItem.create({
      data: { ...data, businessId },
    });
  }

  async updateItem(businessId, itemId, data) {
    const existing = await prisma.inventoryItem.findFirst({
      where: { id: itemId, businessId },
    });
    if (!existing) throw Object.assign(new Error('Item not found'), { status: 404 });

    return prisma.inventoryItem.update({
      where: { id: itemId },
      data,
    });
  }

  // ─── Locations ───────────────────────────────────────────

  async listLocations(businessId) {
    return prisma.inventoryLocation.findMany({
      where: { businessId, isActive: true },
      include: {
        stockLevels: {
          include: { item: { select: { id: true, name: true, unit: true, type: true } } },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async createLocation(businessId, data) {
    return prisma.inventoryLocation.create({
      data: { ...data, businessId },
    });
  }

  async updateLocation(businessId, locationId, data) {
    const existing = await prisma.inventoryLocation.findFirst({
      where: { id: locationId, businessId },
    });
    if (!existing) throw Object.assign(new Error('Location not found'), { status: 404 });

    return prisma.inventoryLocation.update({
      where: { id: locationId },
      data,
    });
  }

  // ─── Stock overview ──────────────────────────────────────

  async getStock(businessId, { locationId, lowStockOnly } = {}) {
    const items = await prisma.inventoryItem.findMany({
      where: { businessId, isActive: true },
      include: {
        stockLevels: {
          where: locationId ? { locationId } : undefined,
          include: { location: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    const rows = items.map((item) => {
      const totalQty = item.stockLevels.reduce((sum, s) => sum + s.quantity, 0);
      const isLow =
        item.reorderPoint != null && totalQty <= item.reorderPoint;
      return {
        ...item,
        totalQuantity: totalQty,
        isLowStock: isLow,
      };
    });

    if (lowStockOnly) return rows.filter((r) => r.isLowStock);
    return rows;
  }

  // ─── Movements (core stock mutation) ─────────────────────

  /**
   * Creates a stock movement and keeps InventoryStock in sync.
   * Rules:
   * - PURCHASE / RETURN  → requires toLocationId, increases stock
   * - USAGE / WRITE_OFF  → requires fromLocationId, decreases stock
   * - TRANSFER           → requires both, moves quantity
   * - ADJUSTMENT         → requires toLocationId (or from), signed quantity handled via type
   */
  async createMovement(businessId, data, performedById) {
    const { itemId, type, quantity, fromLocationId, toLocationId, bookingId, notes } = data;

    // Validate item belongs to business
    const item = await prisma.inventoryItem.findFirst({
      where: { id: itemId, businessId },
    });
    if (!item) throw Object.assign(new Error('Item not found'), { status: 404 });

    return prisma.$transaction(async (tx) => {
      // Helper to adjust stock
      const adjustStock = async (locationId, delta) => {
        if (!locationId) return;
        const existing = await tx.inventoryStock.findUnique({
          where: { itemId_locationId: { itemId, locationId } },
        });
        if (existing) {
          const newQty = existing.quantity + delta;
          if (newQty < 0) {
            throw Object.assign(new Error('Insufficient stock'), { status: 400 });
          }
          await tx.inventoryStock.update({
            where: { id: existing.id },
            data: { quantity: newQty },
          });
        } else {
          if (delta < 0) {
            throw Object.assign(new Error('Insufficient stock'), { status: 400 });
          }
          await tx.inventoryStock.create({
            data: { itemId, locationId, quantity: delta },
          });
        }
      };

      switch (type) {
        case 'PURCHASE':
        case 'RETURN':
          if (!toLocationId) throw Object.assign(new Error('toLocationId required'), { status: 400 });
          await adjustStock(toLocationId, quantity);
          break;

        case 'USAGE':
        case 'WRITE_OFF':
          if (!fromLocationId) throw Object.assign(new Error('fromLocationId required'), { status: 400 });
          await adjustStock(fromLocationId, -quantity);
          break;

        case 'TRANSFER':
          if (!fromLocationId || !toLocationId) {
            throw Object.assign(new Error('fromLocationId and toLocationId required'), { status: 400 });
          }
          await adjustStock(fromLocationId, -quantity);
          await adjustStock(toLocationId, quantity);
          break;

        case 'ADJUSTMENT':
          // Positive quantity increases at toLocation, negative decreases at fromLocation
          if (toLocationId) await adjustStock(toLocationId, quantity);
          else if (fromLocationId) await adjustStock(fromLocationId, -quantity);
          else throw Object.assign(new Error('location required for adjustment'), { status: 400 });
          break;

        default:
          throw Object.assign(new Error('Unknown movement type'), { status: 400 });
      }

      const movement = await tx.stockMovement.create({
        data: {
          businessId,
          itemId,
          type,
          quantity,
          fromLocationId: fromLocationId || null,
          toLocationId: toLocationId || null,
          bookingId: bookingId || null,
          notes: notes || null,
          performedById: performedById || null,
        },
      });

      return movement;
    });
  }

  // ─── Job usage (called from cleaner app / complete flow) ─

  async recordJobUsage(businessId, bookingId, { itemId, quantity, notes, locationId }, recordedBy) {
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, businessId },
    });
    if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });

    // Create movement (USAGE) + JobInventoryUsage row
    await this.createMovement(
      businessId,
      {
        itemId,
        type: 'USAGE',
        quantity,
        fromLocationId: locationId,
        bookingId,
        notes,
      },
      recordedBy
    );

    return prisma.jobInventoryUsage.create({
      data: {
        bookingId,
        itemId,
        quantity,
        notes: notes || null,
        recordedBy: recordedBy || null,
      },
    });
  }
}

module.exports = new InventoryService();
