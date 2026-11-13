import 'dotenv/config';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import supertest = require('supertest');
import {
  CommissionAllocationReason,
  CommissionApplicationReversalReason,
  CommissionCreditReason,
  CommissionEvidenceStatus,
  CommissionRecognitionJobStatus,
  CommissionRecognitionStatus,
  CommissionRemittanceMethod,
  CommissionRemittanceStatus,
  OrderStatus,
  PaymentStatus,
  PrismaClient,
  UserRole,
} from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { ApprovedSupplierGuard } from '../auth/approved-supplier.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { CommissionLedgerService } from './commission-ledger.service';
import { CommissionRecognitionRecovery } from './commission-recognition.recovery';
import { CommissionsController } from './commissions.controller';
import { CommissionsService } from './commissions.service';

jest.setTimeout(90000);

const run = `pgc${Date.now().toString(36)}`;

function assertLocalDatabase(raw: string) {
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '5433' || name !== 'winger') {
    throw new Error(`Refusing database ${url.hostname}:${url.port}/${name}`);
  }
}

function sessionUrl(raw: string, name: string) {
  const url = new URL(raw);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('application_name', name);
  return url.toString();
}

function money(value: unknown) {
  return Math.round(Number(value) * 100) / 100;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Bundle = {
  ledger: CommissionLedgerService;
  commissions: CommissionsService;
  recovery: CommissionRecognitionRecovery;
};

function bundle(db: PrismaClient): Bundle {
  const audit = new AuditService(db as never);
  const ledger = new CommissionLedgerService(db as never, audit, {} as never);
  const commissions = new CommissionsService(db as never, audit, ledger);
  const recovery = new CommissionRecognitionRecovery(commissions, ledger);
  return { ledger, commissions, recovery };
}

describe('PostgreSQL commission concurrency', () => {
  let sessionA: PrismaClient;
  let sessionB: PrismaClient;
  let sessionC: PrismaClient;
  let ledgerA: Bundle;
  let ledgerB: Bundle;
  let ledgerC: Bundle;
  let admin: AuthUser;
  let customerId = '';
  const supplierIds: string[] = [];
  const userIds: string[] = [];
  const orderIds: string[] = [];

  beforeAll(async () => {
    const raw = process.env.DATABASE_URL ?? '';
    assertLocalDatabase(raw);
    sessionA = new PrismaClient({ datasources: { db: { url: sessionUrl(raw, 'winger-pgc-a') } } });
    sessionB = new PrismaClient({ datasources: { db: { url: sessionUrl(raw, 'winger-pgc-b') } } });
    sessionC = new PrismaClient({ datasources: { db: { url: sessionUrl(raw, 'winger-pgc-c') } } });
    await Promise.all([sessionA.$connect(), sessionB.$connect(), sessionC.$connect()]);
    const pids = await Promise.all(
      [sessionA, sessionB, sessionC].map((db) =>
        db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`,
      ),
    );
    expect(new Set(pids.map((row) => Number(row[0].pid))).size).toBe(3);
    ledgerA = bundle(sessionA);
    ledgerB = bundle(sessionB);
    ledgerC = bundle(sessionC);
    await deleteFixtureSuppliers(sessionC);

    const adminId = `${run}-admin`;
    customerId = `${run}-customer`;
    await sessionC.user.create({
      data: {
        id: adminId,
        email: `${run}-admin@pgc.invalid`,
        passwordHash: 'fixture-not-a-login',
        name: 'PG concurrency admin',
        role: UserRole.ADMIN,
      },
    });
    await sessionC.user.create({
      data: {
        id: customerId,
        email: `${run}-customer@pgc.invalid`,
        passwordHash: 'fixture-not-a-login',
        name: 'PG concurrency customer',
        role: UserRole.CUSTOMER,
      },
    });
    userIds.push(adminId, customerId);
    admin = {
      sub: adminId,
      email: `${run}-admin@pgc.invalid`,
      name: 'PG concurrency admin',
      role: UserRole.ADMIN,
    };
  });

  afterAll(async () => {
    if (sessionC) await cleanup(sessionC, supplierIds, userIds, orderIds);
    await Promise.all([
      sessionA?.$disconnect(),
      sessionB?.$disconnect(),
      sessionC?.$disconnect(),
    ]);
  });

  it('allocates verified cash once across two sessions, including a rollback and a blocked retry', async () => {
    const supplierId = await makeSupplier(sessionC, supplierIds, 'cash');
    const productId = `${supplierId}-product`;
    const orderId = await makeOrder(sessionC, orderIds, {
      id: `${run}-cash-order`,
      customerId,
      paymentStatus: PaymentStatus.PAID,
    });
    const lineId = await makeLine(sessionC, {
      id: `${run}-cash-line`,
      orderId,
      productId,
      supplierId,
      itemStatus: OrderStatus.DELIVERED,
      commission: 40,
      commissionStatus: CommissionRecognitionStatus.SETTLEABLE,
      settleableAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const remittanceId = await makeRemittance(sessionC, {
      id: `${run}-cash-rem`,
      supplierId,
      adminId: admin.sub,
      amount: 25,
      autoApply: true,
    });

    await expect(
      sessionA.$transaction(async (tx) => {
        await tx.commissionAllocation.create({
          data: {
            id: `${run}-cash-rolled-back`,
            remittanceId,
            orderItemCommissionId: lineId,
            amountUsd: '25.00',
            reason: CommissionAllocationReason.SWEEP,
            actorUserId: 'commission-sweep',
            actorType: 'SYSTEM',
            systemActorKey: 'commission-sweep',
          },
        });
        await tx.commissionSystemEvent.create({
          data: {
            id: `${run}-cash-rolled-event`,
            actorType: 'SYSTEM',
            systemActorKey: 'commission-sweep',
            entityType: 'CommissionAllocation',
            entityId: `${run}-cash-rolled-back`,
            action: 'COMMISSION_ALLOCATED',
            supplierId,
            afterJson: { amountUsd: 25 },
          },
        });
        throw new Error('rollback cash fixture');
      }),
    ).rejects.toThrow('rollback cash fixture');
    expect(await sessionC.commissionAllocation.count({ where: { remittanceId } })).toBe(0);
    expect(
      await sessionC.commissionSystemEvent.count({ where: { entityId: `${run}-cash-rolled-back` } }),
    ).toBe(0);

    let locked = false;
    let releaseHold = () => {};
    const holdGate = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const holder = sessionA.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "CommissionRemittance" WHERE id = ${remittanceId} FOR UPDATE`;
        locked = true;
        await holdGate;
      },
      { timeout: 20000 },
    );
    while (!locked) await sleep(20);

    let finished = false;
    const sweep = ledgerB.ledger.sweepSupplier(supplierId).finally(() => {
      finished = true;
    });
    await sleep(400);
    expect(finished).toBe(false);
    expect(await sessionC.commissionAllocation.count({ where: { remittanceId } })).toBe(0);
    releaseHold();
    await holder;
    await sweep;

    expect(await allocatedTotal(sessionC, remittanceId)).toBe(25);
    await ledgerA.ledger.sweepSupplier(supplierId);
    expect(await allocatedTotal(sessionC, remittanceId)).toBe(25);
    expect(await sessionC.commissionAllocation.count({ where: { remittanceId } })).toBe(1);

    const paired = await sessionC.$queryRaw<{ allocation_xmin: string; event_xmin: string; actor: string; key: string }[]>`
      SELECT a.xmin::text AS allocation_xmin,
             e.xmin::text AS event_xmin,
             e."actorType"::text AS actor,
             e."systemActorKey" AS key
      FROM "CommissionAllocation" a
      JOIN "CommissionSystemEvent" e ON e."entityId" = a.id
      WHERE a."remittanceId" = ${remittanceId}
    `;
    expect(paired).toHaveLength(1);
    expect(paired[0].allocation_xmin).toBe(paired[0].event_xmin);
    expect(paired[0].actor).toBe('SYSTEM');
    expect(paired[0].key).toBe('commission-sweep');
    expect(
      await sessionC.auditLog.count({
        where: { entityType: 'CommissionAllocation', entityId: { contains: run } },
      }),
    ).toBe(0);

    const activity = await ledgerC.ledger.listAllocationActivity(admin, { supplierId });
    expect(activity.allocations).toEqual([
      expect.objectContaining({
        remittanceId,
        supplierId,
        orderItemCommissionId: lineId,
        amountUsd: 25,
        reason: 'SWEEP',
        actorType: 'SYSTEM',
        systemActor: 'commission-sweep',
        actorUserId: null,
      }),
    ]);
    const otherSupplier = await makeSupplier(sessionC, supplierIds, 'cash-other');
    const other = await ledgerC.ledger.listAllocationActivity(admin, { supplierId: otherSupplier });
    expect(other.allocations).toEqual([]);
  });

  it('lets two sessions race the same remittance without allocating it twice', async () => {
    const supplierId = await makeSupplier(sessionC, supplierIds, 'cash-race');
    const productId = `${supplierId}-product`;
    const orderId = await makeOrder(sessionC, orderIds, {
      id: `${run}-race-order`,
      customerId,
      paymentStatus: PaymentStatus.PAID,
    });
    const oldLine = await makeLine(sessionC, {
      id: `${run}-race-old`,
      orderId,
      productId,
      supplierId,
      itemStatus: OrderStatus.DELIVERED,
      commission: 10,
      commissionStatus: CommissionRecognitionStatus.SETTLEABLE,
      settleableAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newLine = await makeLine(sessionC, {
      id: `${run}-race-new`,
      orderId,
      productId,
      supplierId,
      itemStatus: OrderStatus.DELIVERED,
      commission: 20,
      commissionStatus: CommissionRecognitionStatus.SETTLEABLE,
      settleableAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    const remittanceId = await makeRemittance(sessionC, {
      id: `${run}-race-rem`,
      supplierId,
      adminId: admin.sub,
      amount: 25,
      autoApply: true,
    });

    await Promise.all([
      ledgerA.ledger.sweepSupplier(supplierId),
      ledgerB.ledger.sweepSupplier(supplierId),
    ]);
    const rows = await sessionC.commissionAllocation.findMany({
      where: { remittanceId },
      orderBy: { orderItemCommissionId: 'asc' },
    });
    expect(rows.reduce((sum, row) => sum + money(row.amountUsd), 0)).toBe(25);
    expect(money(rows.find((row) => row.orderItemCommissionId === oldLine)?.amountUsd)).toBe(10);
    expect(money(rows.find((row) => row.orderItemCommissionId === newLine)?.amountUsd)).toBe(15);
    await ledgerA.ledger.sweepSupplier(supplierId);
    expect(await allocatedTotal(sessionC, remittanceId)).toBe(25);
    expect(await sessionC.commissionAllocation.count({ where: { orderItemCommissionId: oldLine } })).toBe(1);
    expect(await sessionC.commissionAllocation.count({ where: { orderItemCommissionId: newLine } })).toBe(1);
  });

  it('consumes a credit source once across two sessions and restores only a partial reversal', async () => {
    const supplierId = await makeSupplier(sessionC, supplierIds, 'credit');
    const productId = `${supplierId}-product`;
    const orderId = await makeOrder(sessionC, orderIds, {
      id: `${run}-credit-order`,
      customerId,
      paymentStatus: PaymentStatus.PAID,
    });
    const payableId = await makeLine(sessionC, {
      id: `${run}-credit-payable`,
      orderId,
      productId,
      supplierId,
      itemStatus: OrderStatus.DELIVERED,
      commission: 30,
      commissionStatus: CommissionRecognitionStatus.SETTLEABLE,
      settleableAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const anchorId = await makeLine(sessionC, {
      id: `${run}-credit-anchor`,
      orderId,
      productId,
      supplierId,
      itemStatus: OrderStatus.PROCESSING,
      commission: 30,
      commissionStatus: CommissionRecognitionStatus.RECOGNIZED,
    });
    const fundingId = await makeRemittance(sessionC, {
      id: `${run}-credit-funding`,
      supplierId,
      adminId: admin.sub,
      amount: 30,
      autoApply: false,
    });
    const allocationId = `${run}-credit-anchor-alloc`;
    await sessionC.commissionAllocation.create({
      data: {
        id: allocationId,
        remittanceId: fundingId,
        orderItemCommissionId: anchorId,
        amountUsd: '30.00',
        reason: CommissionAllocationReason.MANUAL,
        actorUserId: admin.sub,
        actorType: 'USER',
      },
    });
    const creditId = `${run}-credit`;
    await sessionC.commissionCredit.create({
      data: {
        id: creditId,
        supplierId,
        orderItemCommissionId: payableId,
        amountUsd: '30.00',
        reason: CommissionCreditReason.CLAWBACK_AFTER_COLLECTION,
        sourceEventKey: `${run}-credit-key`,
        actorUserId: admin.sub,
        sources: {
          create: [{ id: `${run}-credit-source`, allocationId, amountUsd: '30.00' }],
        },
      },
    });

    await expect(
      sessionA.$transaction(async (tx) => {
        const application = await tx.commissionCreditApplication.create({
          data: {
            id: `${run}-credit-rolled-app`,
            creditId,
            orderItemCommissionId: payableId,
            amountUsd: '30.00',
            reason: 'AUTO',
            actorUserId: 'commission-sweep',
            actorType: 'SYSTEM',
            systemActorKey: 'commission-sweep',
          },
        });
        await tx.commissionCreditApplicationSource.create({
          data: {
            id: `${run}-credit-rolled-source`,
            applicationId: application.id,
            creditSourceId: `${run}-credit-source`,
            amountUsd: '30.00',
          },
        });
        await tx.commissionSystemEvent.create({
          data: {
            id: `${run}-credit-rolled-event`,
            actorType: 'SYSTEM',
            systemActorKey: 'commission-sweep',
            entityType: 'CommissionCreditApplication',
            entityId: application.id,
            action: 'COMMISSION_CREDIT_APPLIED',
            supplierId,
          },
        });
        throw new Error('rollback credit fixture');
      }),
    ).rejects.toThrow('rollback credit fixture');
    expect(await sessionC.commissionCreditApplication.count({ where: { creditId } })).toBe(0);
    expect(
      await sessionC.commissionSystemEvent.count({ where: { id: `${run}-credit-rolled-event` } }),
    ).toBe(0);

    await Promise.all([
      ledgerA.ledger.sweepSupplier(supplierId),
      ledgerB.ledger.sweepSupplier(supplierId),
    ]);
    expect(await appliedCredit(sessionC, creditId)).toBe(30);
    expect(await sessionC.commissionCreditApplication.count({ where: { creditId } })).toBe(1);
    await ledgerB.ledger.sweepSupplier(supplierId);
    expect(await appliedCredit(sessionC, creditId)).toBe(30);
    const creditEvents = await sessionC.$queryRaw<{ app_xmin: string; event_xmin: string; actor: string }[]>`
      SELECT a.xmin::text AS app_xmin, e.xmin::text AS event_xmin, e."actorType"::text AS actor
      FROM "CommissionCreditApplication" a
      JOIN "CommissionSystemEvent" e ON e."entityId" = a.id
      WHERE a."creditId" = ${creditId}
    `;
    expect(creditEvents).toHaveLength(1);
    expect(creditEvents[0].app_xmin).toBe(creditEvents[0].event_xmin);
    expect(creditEvents[0].actor).toBe('SYSTEM');

    const partialSupplier = await makeSupplier(sessionC, supplierIds, 'credit-partial');
    const partialProduct = `${partialSupplier}-product`;
    const partialOrder = await makeOrder(sessionC, orderIds, {
      id: `${run}-partial-order`,
      customerId,
      paymentStatus: PaymentStatus.PAID,
    });
    const partialPayable = await makeLine(sessionC, {
      id: `${run}-partial-payable`,
      orderId: partialOrder,
      productId: partialProduct,
      supplierId: partialSupplier,
      itemStatus: OrderStatus.DELIVERED,
      commission: 100,
      commissionStatus: CommissionRecognitionStatus.SETTLEABLE,
      settleableAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const partialAnchor = await makeLine(sessionC, {
      id: `${run}-partial-anchor`,
      orderId: partialOrder,
      productId: partialProduct,
      supplierId: partialSupplier,
      itemStatus: OrderStatus.PROCESSING,
      commission: 100,
      commissionStatus: CommissionRecognitionStatus.RECOGNIZED,
    });
    const partialFunding = await makeRemittance(sessionC, {
      id: `${run}-partial-funding`,
      supplierId: partialSupplier,
      adminId: admin.sub,
      amount: 100,
      autoApply: false,
    });
    await sessionC.commissionAllocation.createMany({
      data: [
        {
          id: `${run}-partial-alloc-a`,
          remittanceId: partialFunding,
          orderItemCommissionId: partialAnchor,
          amountUsd: '60.00',
          reason: CommissionAllocationReason.MANUAL,
          actorUserId: admin.sub,
          actorType: 'USER',
        },
        {
          id: `${run}-partial-alloc-b`,
          remittanceId: partialFunding,
          orderItemCommissionId: partialAnchor,
          amountUsd: '40.00',
          reason: CommissionAllocationReason.MANUAL,
          actorUserId: admin.sub,
          actorType: 'USER',
        },
      ],
    });
    const partialCredit = `${run}-partial-credit`;
    await sessionC.commissionCredit.create({
      data: {
        id: partialCredit,
        supplierId: partialSupplier,
        orderItemCommissionId: partialPayable,
        amountUsd: '100.00',
        reason: CommissionCreditReason.CLAWBACK_AFTER_COLLECTION,
        sourceEventKey: `${run}-partial-key`,
        actorUserId: admin.sub,
        sources: {
          create: [
            {
              id: `${run}-source-a`,
              allocationId: `${run}-partial-alloc-a`,
              amountUsd: '60.00',
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
            },
            {
              id: `${run}-source-b`,
              allocationId: `${run}-partial-alloc-b`,
              amountUsd: '40.00',
              createdAt: new Date('2026-01-02T00:00:00.000Z'),
            },
          ],
        },
      },
    });
    await ledgerC.ledger.sweepSupplier(partialSupplier);
    const before = await sourcePositions(sessionC, partialCredit);
    expect(before.a.active).toBe(60);
    expect(before.b.active).toBe(40);
    await sessionC.commissionCreditApplicationSourceReversal.create({
      data: {
        id: `${run}-partial-reversal`,
        applicationSourceId: before.a.applicationSourceId,
        amountUsd: '25.00',
        reason: CommissionApplicationReversalReason.CUSTOMER_REFUND,
        reversalKey: `${run}-partial-reversal-key`,
        actorUserId: admin.sub,
      },
    });
    const restored = await sourcePositions(sessionC, partialCredit);
    expect(restored.a.remaining).toBe(25);
    expect(restored.b.remaining).toBe(0);
    expect(restored.b.active).toBe(40);
    expect(restored.b.applicationSourceId).toBe(before.b.applicationSourceId);
    await ledgerA.ledger.sweepSupplier(partialSupplier);
    const after = await sourcePositions(sessionC, partialCredit);
    expect(after.a.remaining).toBe(0);
    expect(after.b.active).toBe(40);
    expect(after.b.amount).toBe(40);
    expect(after.a.amount).toBe(60);
    expect(after.a.active + after.a.offsets).toBeLessThanOrEqual(after.a.amount);
    expect(after.b.active + after.b.offsets).toBeLessThanOrEqual(after.b.amount);
    expect(await appliedCredit(sessionC, partialCredit)).toBe(100);
  });

  it('verifies the final two Lipa suppliers concurrently and recovers recognition once', async () => {
    const supplierA = await makeSupplier(sessionC, supplierIds, 'lipa-a');
    const supplierB = await makeSupplier(sessionC, supplierIds, 'lipa-b');
    const orderId = await makeOrder(sessionC, orderIds, {
      id: `${run}-lipa-order`,
      customerId,
      paymentStatus: PaymentStatus.PENDING,
    });
    const lineA = await makeLine(sessionC, {
      id: `${run}-lipa-line-a`,
      orderId,
      productId: `${supplierA}-product`,
      supplierId: supplierA,
      itemStatus: OrderStatus.DELIVERED,
      commission: 10,
      commissionStatus: CommissionRecognitionStatus.PENDING,
    });
    const lineB = await makeLine(sessionC, {
      id: `${run}-lipa-line-b`,
      orderId,
      productId: `${supplierB}-product`,
      supplierId: supplierB,
      itemStatus: OrderStatus.DELIVERED,
      commission: 8,
      commissionStatus: CommissionRecognitionStatus.PENDING,
    });
    await makeLine(sessionC, {
      id: `${run}-lipa-cancelled`,
      orderId,
      productId: `${supplierA}-product`,
      supplierId: supplierA,
      itemStatus: OrderStatus.CANCELLED,
      commission: 4,
      commissionStatus: CommissionRecognitionStatus.PENDING,
    });
    const evidenceA = await makeEvidence(sessionC, {
      id: `${run}-lipa-ev-a`,
      orderId,
      supplierId: supplierA,
      adminId: admin.sub,
    });
    const evidenceB = await makeEvidence(sessionC, {
      id: `${run}-lipa-ev-b`,
      orderId,
      supplierId: supplierB,
      adminId: admin.sub,
    });
    await makeRemittance(sessionC, {
      id: `${run}-lipa-rem-a`,
      supplierId: supplierA,
      adminId: admin.sub,
      amount: 10,
      autoApply: true,
    });

    await Promise.all([
      ledgerA.ledger.reviewLipaEvidence(admin, evidenceA, { approve: true }),
      ledgerB.ledger.reviewLipaEvidence(admin, evidenceB, { approve: true }),
    ]);
    const order = await sessionC.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).toBe(PaymentStatus.PAID);
    const evidence = await sessionC.customerPaymentEvidence.findMany({ where: { orderId } });
    expect(evidence.map((row) => row.status).sort()).toEqual([
      CommissionEvidenceStatus.VERIFIED,
      CommissionEvidenceStatus.VERIFIED,
    ]);
    const jobs = await sessionC.commissionRecognitionJob.findMany({ where: { orderId } });
    expect(jobs.map((job) => job.orderItemId).sort()).toEqual([lineA, lineB].sort());
    expect(await sessionC.orderItemCommission.count({ where: { id: { in: [lineA, lineB] } } })).toBe(2);
    expect(
      (await sessionC.orderItemCommission.findUniqueOrThrow({ where: { id: lineA } })).status,
    ).toBe(CommissionRecognitionStatus.PENDING);

    const first = await ledgerC.recovery.run(orderId);
    expect(first.sweptSuppliers.sort()).toEqual([supplierA, supplierB].sort());
    expect(
      (await sessionC.orderItemCommission.findUniqueOrThrow({ where: { id: lineA } })).status,
    ).toBe(CommissionRecognitionStatus.SETTLEABLE);
    expect(
      (await sessionC.orderItemCommission.findUniqueOrThrow({ where: { id: lineB } })).status,
    ).toBe(CommissionRecognitionStatus.SETTLEABLE);
    expect(
      (await sessionC.orderItemCommission.findUniqueOrThrow({ where: { id: `${run}-lipa-cancelled` } })).status,
    ).toBe(CommissionRecognitionStatus.PENDING);
    expect(await allocatedTotal(sessionC, `${run}-lipa-rem-a`)).toBe(10);

    await ledgerA.ledger.reviewLipaEvidence(admin, evidenceA, { approve: true });
    await ledgerB.ledger.reviewLipaEvidence(admin, evidenceB, { approve: true });
    expect(await sessionC.commissionRecognitionJob.count({ where: { orderId } })).toBe(2);
    const second = await ledgerC.recovery.recover(admin, orderId);
    expect(second.processed).toBe(0);
    expect(await allocatedTotal(sessionC, `${run}-lipa-rem-a`)).toBe(10);
    expect(await sessionC.orderItemCommission.count({ where: { orderItem: { orderId } } })).toBe(3);
  });

  it('resumes recognition after each committed interruption without duplicating records', async () => {
    const earlyA = await makeSupplier(sessionC, supplierIds, 'early-a');
    const earlyB = await makeSupplier(sessionC, supplierIds, 'early-b');
    const earlyOrder = await makeOrder(sessionC, orderIds, {
      id: `${run}-early-order`,
      customerId,
      paymentStatus: PaymentStatus.PENDING,
    });
    const earlyLineA = await makeLine(sessionC, {
      id: `${run}-early-line-a`,
      orderId: earlyOrder,
      productId: `${earlyA}-product`,
      supplierId: earlyA,
      itemStatus: OrderStatus.DELIVERED,
      commission: 6,
      commissionStatus: CommissionRecognitionStatus.PENDING,
    });
    await makeLine(sessionC, {
      id: `${run}-early-line-b`,
      orderId: earlyOrder,
      productId: `${earlyB}-product`,
      supplierId: earlyB,
      itemStatus: OrderStatus.DELIVERED,
      commission: 6,
      commissionStatus: CommissionRecognitionStatus.PENDING,
    });
    const earlyEvidenceA = await makeEvidence(sessionC, {
      id: `${run}-early-ev-a`,
      orderId: earlyOrder,
      supplierId: earlyA,
      adminId: admin.sub,
    });
    await makeEvidence(sessionC, {
      id: `${run}-early-ev-b`,
      orderId: earlyOrder,
      supplierId: earlyB,
      adminId: admin.sub,
    });
    const early = await ledgerA.ledger.reviewLipaEvidence(admin, earlyEvidenceA, { approve: true });
    expect(early.recoveryRequired).toBe(false);
    expect(
      (await sessionC.order.findUniqueOrThrow({ where: { id: earlyOrder } })).paymentStatus,
    ).toBe(PaymentStatus.PENDING);
    expect(await sessionC.commissionRecognitionJob.count({ where: { orderId: earlyOrder } })).toBe(0);
    expect(
      (await sessionC.orderItemCommission.findUniqueOrThrow({ where: { id: earlyLineA } })).status,
    ).toBe(CommissionRecognitionStatus.PENDING);
    const earlyAgain = await ledgerC.recovery.run(earlyOrder);
    expect(earlyAgain.processed).toBe(0);

    const supplierId = await makeSupplier(sessionC, supplierIds, 'recover');
    const orderId = await makeOrder(sessionC, orderIds, {
      id: `${run}-recover-order`,
      customerId,
      paymentStatus: PaymentStatus.PAID,
    });
    const lineId = await makeLine(sessionC, {
      id: `${run}-recover-line`,
      orderId,
      productId: `${supplierId}-product`,
      supplierId,
      itemStatus: OrderStatus.DELIVERED,
      commission: 12,
      commissionStatus: CommissionRecognitionStatus.PENDING,
    });
    const remittanceId = await makeRemittance(sessionC, {
      id: `${run}-recover-rem`,
      supplierId,
      adminId: admin.sub,
      amount: 12,
      autoApply: true,
    });
    const jobId = `${run}-recover-job`;
    await sessionC.commissionRecognitionJob.create({
      data: {
        id: jobId,
        orderId,
        orderItemId: lineId,
        supplierId,
        status: CommissionRecognitionJobStatus.PENDING,
      },
    });

    const beforeAdvance = await sessionC.orderItemCommission.findUniqueOrThrow({ where: { id: lineId } });
    expect(beforeAdvance.status).toBe(CommissionRecognitionStatus.PENDING);
    await ledgerC.commissions.advanceRecognitionForItem(lineId);
    await ledgerC.ledger.setRecognitionJobStatus(jobId, CommissionRecognitionJobStatus.AWAITING_SWEEP);
    expect(await allocatedTotal(sessionC, remittanceId)).toBe(0);

    await ledgerA.recovery.run(orderId);
    expect(
      (await sessionC.orderItemCommission.findUniqueOrThrow({ where: { id: lineId } })).status,
    ).toBe(CommissionRecognitionStatus.SETTLEABLE);
    expect(await allocatedTotal(sessionC, remittanceId)).toBe(12);
    expect(
      (await sessionC.commissionRecognitionJob.findUniqueOrThrow({ where: { id: jobId } })).status,
    ).toBe(CommissionRecognitionJobStatus.COMPLETED);

    await sessionC.commissionRecognitionJob.update({
      where: { id: jobId },
      data: { status: CommissionRecognitionJobStatus.AWAITING_SWEEP, completedAt: null },
    });
    await Promise.all([ledgerA.recovery.run(orderId), ledgerB.recovery.run(orderId)]);
    expect(await allocatedTotal(sessionC, remittanceId)).toBe(12);
    expect(await sessionC.commissionAllocation.count({ where: { remittanceId } })).toBe(1);
    expect(await sessionC.orderItemCommission.count({ where: { id: lineId } })).toBe(1);
    expect(
      (await sessionC.orderItemCommission.findUniqueOrThrow({ where: { id: lineId } })).status,
    ).toBe(CommissionRecognitionStatus.SETTLEABLE);
    const done = await ledgerC.recovery.recover(admin, orderId);
    expect(done.processed).toBe(0);
    expect(await allocatedTotal(sessionC, remittanceId)).toBe(12);
  });

  it('requires an administrator JWT and does not let another caller recover a supplier', async () => {
    const supplierId = await makeSupplier(sessionC, supplierIds, 'http');
    const otherSupplier = await makeSupplier(sessionC, supplierIds, 'http-other');
    const orderId = await makeOrder(sessionC, orderIds, {
      id: `${run}-http-order`,
      customerId,
      paymentStatus: PaymentStatus.PAID,
    });
    const otherOrder = await makeOrder(sessionC, orderIds, {
      id: `${run}-http-other-order`,
      customerId,
      paymentStatus: PaymentStatus.PAID,
    });
    const lineId = await makeLine(sessionC, {
      id: `${run}-http-line`,
      orderId,
      productId: `${supplierId}-product`,
      supplierId,
      itemStatus: OrderStatus.DELIVERED,
      commission: 5,
      commissionStatus: CommissionRecognitionStatus.PENDING,
    });
    const otherLine = await makeLine(sessionC, {
      id: `${run}-http-other-line`,
      orderId: otherOrder,
      productId: `${otherSupplier}-product`,
      supplierId: otherSupplier,
      itemStatus: OrderStatus.DELIVERED,
      commission: 5,
      commissionStatus: CommissionRecognitionStatus.PENDING,
    });
    await sessionC.commissionRecognitionJob.createMany({
      data: [
        {
          id: `${run}-http-job`,
          orderId,
          orderItemId: lineId,
          supplierId,
          status: CommissionRecognitionJobStatus.PENDING,
        },
        {
          id: `${run}-http-other-job`,
          orderId: otherOrder,
          orderItemId: otherLine,
          supplierId: otherSupplier,
          status: CommissionRecognitionJobStatus.PENDING,
        },
      ],
    });
    const supplierUserId = `${run}-http-supplier-user`;
    await sessionC.user.create({
      data: {
        id: supplierUserId,
        email: `${run}-http-supplier@pgc.invalid`,
        passwordHash: 'fixture-not-a-login',
        name: 'PG concurrency supplier',
        role: UserRole.SUPPLIER,
        supplierId,
      },
    });
    userIds.push(supplierUserId);

    const secret = process.env.JWT_SECRET || 'winger-dev-secret-change-me';
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret })],
      controllers: [CommissionsController],
      providers: [
        Reflector,
        JwtAuthGuard,
        RolesGuard,
        ApprovedSupplierGuard,
        { provide: PrismaService, useValue: sessionC },
        { provide: CommissionsService, useValue: ledgerC.commissions },
        { provide: CommissionLedgerService, useValue: ledgerC.ledger },
        { provide: CommissionRecognitionRecovery, useValue: ledgerC.recovery },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const jwt = moduleRef.get(JwtService);
    try {
      await supertest(app.getHttpServer()).post('/commissions/admin/recognition/recover').send({ orderId }).expect(401);
      const supplierToken = jwt.sign({
        sub: supplierUserId,
        email: `${run}-http-supplier@pgc.invalid`,
        name: 'PG concurrency supplier',
        role: UserRole.SUPPLIER,
        supplierId,
      });
      const customerToken = jwt.sign({
        sub: customerId,
        email: `${run}-customer@pgc.invalid`,
        name: 'PG concurrency customer',
        role: UserRole.CUSTOMER,
      });
      await supertest(app.getHttpServer())
        .post('/commissions/admin/recognition/recover')
        .set('Authorization', `Bearer ${supplierToken}`)
        .send({ orderId: otherOrder, supplierId: otherSupplier })
        .expect(403);
      await supertest(app.getHttpServer())
        .post('/commissions/admin/recognition/recover')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ orderId: otherOrder })
        .expect(403);

      const adminToken = jwt.sign(admin);
      const adminCall = (body: Record<string, unknown> | undefined) =>
        supertest(app.getHttpServer())
          .post('/commissions/admin/recognition/recover')
          .set('Authorization', `Bearer ${adminToken}`)
          .send(body as Record<string, unknown>);
      await adminCall({}).expect(400);
      await adminCall({ orderId: '' }).expect(400);
      await adminCall({ orderId: '   ' }).expect(400);
      await adminCall({ orderId: 'bad id' }).expect(400);
      await adminCall({ orderId: '../order-id' }).expect(400);
      await adminCall({ orderId: 12345 }).expect(400);
      await adminCall({ orderId: 'missing-order' }).expect(400);
      await adminCall({ orderId, supplierId: otherSupplier }).expect(400);
      await adminCall({ orderId, supplierId: 'bad supplier' }).expect(400);
      expect(
        (await sessionC.commissionRecognitionJob.findUniqueOrThrow({ where: { id: `${run}-http-job` } })).status,
      ).toBe(CommissionRecognitionJobStatus.PENDING);
      expect(
        (await sessionC.commissionRecognitionJob.findUniqueOrThrow({ where: { id: `${run}-http-other-job` } })).status,
      ).toBe(CommissionRecognitionJobStatus.PENDING);

      await adminCall({ orderId }).expect(201);
      expect(
        (await sessionC.commissionRecognitionJob.findUniqueOrThrow({ where: { id: `${run}-http-job` } })).status,
      ).toBe(CommissionRecognitionJobStatus.COMPLETED);
      expect(
        (await sessionC.commissionRecognitionJob.findUniqueOrThrow({ where: { id: `${run}-http-other-job` } })).status,
      ).toBe(CommissionRecognitionJobStatus.PENDING);
      const repeat = await adminCall({ orderId });
      expect(repeat.status).toBe(201);
      expect(repeat.body.processed).toBe(0);

      await expect(
        ledgerC.recovery.recover(
          { ...admin, sub: supplierUserId, role: UserRole.SUPPLIER, supplierId },
          otherOrder,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(ledgerC.ledger.recognitionJobs('')).rejects.toBeInstanceOf(BadRequestException);
      const scoped = await ledgerC.ledger.recognitionJobs(otherOrder);
      expect(scoped.every((job) => job.orderId === otherOrder)).toBe(true);
      expect(scoped.some((job) => job.orderId === orderId)).toBe(false);
    } finally {
      await app.close();
    }
  });
});

async function allocatedTotal(db: PrismaClient, remittanceId: string) {
  const rows = await db.commissionAllocation.findMany({
    where: { remittanceId },
    include: { reversals: true },
  });
  return money(
    rows.reduce(
      (sum, row) =>
        sum + money(row.amountUsd) - row.reversals.reduce((inner, reversal) => inner + money(reversal.amountUsd), 0),
      0,
    ),
  );
}

async function appliedCredit(db: PrismaClient, creditId: string) {
  const rows = await db.commissionCreditApplication.findMany({
    where: { creditId },
    include: { sources: { include: { reversals: true } } },
  });
  return money(
    rows.reduce(
      (sum, row) =>
        sum +
        row.sources.reduce(
          (inner, source) =>
            inner +
            money(source.amountUsd) -
            source.reversals.reduce((reversed, reversal) => reversed + money(reversal.amountUsd), 0),
          0,
        ),
      0,
    ),
  );
}

async function sourcePositions(db: PrismaClient, creditId: string) {
  const credit = await db.commissionCredit.findUniqueOrThrow({
    where: { id: creditId },
    include: {
      sources: {
        include: { offsetSources: true, applicationSources: { include: { reversals: true } } },
      },
    },
  });
  const position = (id: string) => {
    const source = credit.sources.find((row) => row.id === id);
    if (!source) throw new Error(`missing source ${id}`);
    const offsets = money(source.offsetSources.reduce((sum, row) => sum + money(row.amountUsd), 0));
    const active = money(
      source.applicationSources.reduce(
        (sum, row) =>
          sum + money(row.amountUsd) - row.reversals.reduce((inner, reversal) => inner + money(reversal.amountUsd), 0),
        0,
      ),
    );
    return {
      amount: money(source.amountUsd),
      offsets,
      active,
      remaining: money(money(source.amountUsd) - offsets - active),
      applicationSourceId: source.applicationSources[0]?.id ?? '',
    };
  };
  return { a: position(`${run}-source-a`), b: position(`${run}-source-b`) };
}

async function makeSupplier(db: PrismaClient, supplierIds: string[], label: string) {
  const supplierId = `${run}-${label}`;
  await db.supplier.create({
    data: { id: supplierId, name: `PG CONCURRENCY FIXTURE ${label}`, verificationStatus: 'APPROVED' },
  });
  supplierIds.push(supplierId);
  await db.product.create({
    data: {
      id: `${supplierId}-product`,
      name: 'PG concurrency fixture',
      brand: 'Fixture',
      supplierId,
      supplierName: `PG CONCURRENCY FIXTURE ${label}`,
      price: '10.00',
      imageUrl: 'https://example.invalid/pg.png',
      category: 'fixture',
    },
  });
  return supplierId;
}

async function makeOrder(
  db: PrismaClient,
  orderIds: string[],
  input: { id: string; customerId: string; paymentStatus: PaymentStatus },
) {
  await db.order.create({
    data: {
      id: input.id,
      displayId: input.id,
      customerId: input.customerId,
      customerName: 'PG concurrency customer',
      customerEmail: `${run}-customer@pgc.invalid`,
      paymentStatus: input.paymentStatus,
      paymentMode: 'lipa',
      subtotal: '10.00',
      total: '10.00',
    },
  });
  orderIds.push(input.id);
  return input.id;
}

async function makeLine(
  db: PrismaClient,
  input: {
    id: string;
    orderId: string;
    productId: string;
    supplierId: string;
    itemStatus: OrderStatus;
    commission: number;
    commissionStatus: CommissionRecognitionStatus;
    settleableAt?: Date;
  },
) {
  await db.orderItem.create({
    data: {
      id: input.id,
      orderId: input.orderId,
      productId: input.productId,
      productName: 'PG concurrency fixture',
      supplierId: input.supplierId,
      supplierName: input.supplierId,
      unitPrice: input.commission.toFixed(2),
      quantity: 1,
      lineTotal: input.commission.toFixed(2),
      status: input.itemStatus,
    },
  });
  await db.orderItemCommission.create({
    data: {
      id: input.id,
      orderItemId: input.id,
      ratePercent: '10.00',
      commissionBase: input.commission.toFixed(2),
      commissionAmount: input.commission.toFixed(2),
      status: input.commissionStatus,
      paymentMode: 'lipa',
      isDemo: false,
      recognizedAt: input.commissionStatus === CommissionRecognitionStatus.PENDING ? null : new Date(),
      settleableAt: input.settleableAt ?? null,
    },
  });
  return input.id;
}

async function makeRemittance(
  db: PrismaClient,
  input: { id: string; supplierId: string; adminId: string; amount: number; autoApply: boolean },
) {
  await db.commissionRemittance.create({
    data: {
      id: input.id,
      supplierId: input.supplierId,
      method: CommissionRemittanceMethod.WINGER_LIPA,
      status: CommissionRemittanceStatus.VERIFIED,
      claimedAmount: input.amount.toFixed(2),
      claimedCurrency: 'USD',
      verifiedAmountUsd: input.amount.toFixed(2),
      verifiedAt: new Date('2026-03-01T00:00:00.000Z'),
      referenceRaw: input.id,
      referenceNormalized: input.id.toUpperCase(),
      provider: 'TEST',
      merchantAccountKey: `${run}-account`,
      autoApply: input.autoApply,
      submittedByUserId: input.adminId,
    },
  });
  return input.id;
}

async function makeEvidence(
  db: PrismaClient,
  input: { id: string; orderId: string; supplierId: string; adminId: string },
) {
  await db.customerPaymentEvidence.create({
    data: {
      id: input.id,
      orderId: input.orderId,
      supplierId: input.supplierId,
      referenceRaw: input.id,
      referenceNormalized: input.id.toUpperCase(),
      status: CommissionEvidenceStatus.SUBMITTED,
      submittedByUserId: input.adminId,
    },
  });
  return input.id;
}

async function deleteFixtureSuppliers(db: PrismaClient) {
  const leftovers = await db.supplier.findMany({
    where: { name: { startsWith: 'PG CONCURRENCY FIXTURE' } },
    select: { id: true },
  });
  if (!leftovers.length) return;
  const ids = leftovers.map((row) => row.id);
  const users = await db.user.findMany({
    where: { OR: [{ supplierId: { in: ids } }, { email: { endsWith: '@pgc.invalid' } }] },
    select: { id: true },
  });
  const orders = await db.order.findMany({
    where: { items: { some: { supplierId: { in: ids } } } },
    select: { id: true },
  });
  await cleanup(
    db,
    ids,
    users.map((row) => row.id),
    orders.map((row) => row.id),
  );
}

async function cleanup(db: PrismaClient, supplierIds: string[], userIds: string[], orderIds: string[]) {
  if (!supplierIds.length && !userIds.length && !orderIds.length) return;
  const suppliers = supplierIds.length ? supplierIds : ['__none__'];
  await db.commissionSystemEvent.deleteMany({ where: { supplierId: { in: suppliers } } });
  await db.commissionCreditApplicationSourceReversal.deleteMany({
    where: { applicationSource: { creditSource: { credit: { supplierId: { in: suppliers } } } } },
  });
  await db.commissionCreditApplicationSource.deleteMany({
    where: { creditSource: { credit: { supplierId: { in: suppliers } } } },
  });
  await db.commissionCreditApplication.deleteMany({ where: { credit: { supplierId: { in: suppliers } } } });
  await db.commissionCreditOffsetSource.deleteMany({
    where: { creditSource: { credit: { supplierId: { in: suppliers } } } },
  });
  await db.commissionCreditOffset.deleteMany({ where: { credit: { supplierId: { in: suppliers } } } });
  await db.commissionCreditSource.deleteMany({ where: { credit: { supplierId: { in: suppliers } } } });
  await db.commissionCredit.deleteMany({ where: { supplierId: { in: suppliers } } });
  await db.commissionAllocationReversal.deleteMany({
    where: { allocation: { remittance: { supplierId: { in: suppliers } } } },
  });
  await db.commissionAllocation.deleteMany({ where: { remittance: { supplierId: { in: suppliers } } } });
  await db.commissionProviderEvent.deleteMany({
    where: { remittanceReversal: { remittance: { supplierId: { in: suppliers } } } },
  });
  await db.commissionRemittanceReversal.deleteMany({ where: { remittance: { supplierId: { in: suppliers } } } });
  await db.commissionPaymentReference.deleteMany({ where: { remittance: { supplierId: { in: suppliers } } } });
  await db.commissionRemittance.deleteMany({ where: { supplierId: { in: suppliers } } });
  await db.commissionRecognitionJob.deleteMany({ where: { supplierId: { in: suppliers } } });
  await db.customerPaymentEvidenceOpen.deleteMany({ where: { supplierId: { in: suppliers } } });
  await db.customerPaymentEvidence.deleteMany({ where: { supplierId: { in: suppliers } } });
  if (userIds.length) await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await db.orderItemCommission.deleteMany({ where: { orderItem: { supplierId: { in: suppliers } } } });
  await db.orderItem.deleteMany({ where: { supplierId: { in: suppliers } } });
  if (orderIds.length) await db.order.deleteMany({ where: { id: { in: orderIds } } });
  await db.product.deleteMany({ where: { supplierId: { in: suppliers } } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.supplier.deleteMany({ where: { id: { in: suppliers } } });
}
