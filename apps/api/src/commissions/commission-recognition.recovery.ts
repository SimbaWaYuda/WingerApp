import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { CommissionRecognitionJobStatus, CommissionRecognitionStatus, UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { CommissionLedgerService } from './commission-ledger.service';
import { CommissionsService } from './commissions.service';

/** Order and supplier ids used by recovery. Rejects blank, spaced, or path-like values. */
const RECOVERY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function requireRecoveryId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${label} is required`);
  }
  const id = value.trim();
  if (!RECOVERY_ID.test(id)) {
    throw new BadRequestException(`${label} is not valid`);
  }
  return id;
}

/**
 * Recognition is intentionally outside the payment transaction.
 * The API has no job runner. A CommissionRecognitionJob row is committed with
 * the Lipa PAID update, so a later call can finish recognition without
 * verifying the same evidence again. advanceRecognitionForItem only moves a
 * snapshot forward, and sweepSupplier recomputes remaining balances under row locks.
 */
@Injectable()
export class CommissionRecognitionRecovery {
  constructor(
    private readonly commissions: CommissionsService,
    private readonly ledger: CommissionLedgerService,
  ) {}

  async recover(user: AuthUser, orderId: string) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only Winger admins can do this');
    }
    return this.run(orderId);
  }

  async run(orderId: string) {
    const id = requireRecoveryId(orderId, 'Order id');
    const jobs = await this.ledger.recognitionJobs(id);
    for (const job of jobs) {
      if (job.status !== CommissionRecognitionJobStatus.PENDING) continue;
      const snap = await this.commissions.advanceRecognitionForItem(job.orderItemId);
      const next =
        snap?.status === CommissionRecognitionStatus.SETTLEABLE
          ? CommissionRecognitionJobStatus.AWAITING_SWEEP
          : CommissionRecognitionJobStatus.COMPLETED;
      await this.ledger.setRecognitionJobStatus(job.id, next);
      job.status = next;
    }
    const payable = jobs.filter(
      (job) => job.status === CommissionRecognitionJobStatus.AWAITING_SWEEP,
    );
    const suppliers = [...new Set(payable.map((job) => job.supplierId))];
    for (const supplierId of suppliers) {
      await this.ledger.sweepSupplier(supplierId);
    }
    for (const job of payable) {
      await this.ledger.setRecognitionJobStatus(
        job.id,
        CommissionRecognitionJobStatus.COMPLETED,
      );
    }
    return {
      processed: jobs.length,
      sweptSuppliers: suppliers,
    };
  }
}
