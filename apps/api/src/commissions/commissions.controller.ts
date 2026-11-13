import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { ApprovedSupplierGuard } from '../auth/approved-supplier.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthUser } from '../auth/auth.types';
import { CommissionLedgerService } from './commission-ledger.service';
import { CommissionRecognitionRecovery, requireRecoveryId } from './commission-recognition.recovery';
import {
  CommissionsService,
  CounterAgreementDto,
  ProposeAgreementDto,
  UpdateDefaultCommissionDto,
} from './commissions.service';

@Controller('commissions')
@UseGuards(JwtAuthGuard, RolesGuard, ApprovedSupplierGuard)
export class CommissionsController {
  constructor(
    private readonly commissions: CommissionsService,
    private readonly ledger: CommissionLedgerService,
    private readonly recognition: CommissionRecognitionRecovery,
  ) {}

  @Get('settings')
  @Roles(UserRole.ADMIN, UserRole.SUPPLIER)
  getSettings() {
    return this.commissions.getSettings();
  }

  @Patch('settings/default-rate')
  @Roles(UserRole.ADMIN)
  updateDefault(
    @CurrentUser() user: AuthUser,
    @Body() body: UpdateDefaultCommissionDto,
  ) {
    return this.commissions.updateDefaultCommission(body, user);
  }

  @Get('agreements')
  @Roles(UserRole.ADMIN, UserRole.SUPPLIER)
  listAgreements(
    @CurrentUser() user: AuthUser,
    @Query('supplierId') supplierId?: string,
  ) {
    return this.commissions.listAgreements(user, supplierId);
  }

  @Post('agreements')
  @Roles(UserRole.ADMIN, UserRole.SUPPLIER)
  propose(@CurrentUser() user: AuthUser, @Body() body: ProposeAgreementDto) {
    return this.commissions.propose(body, user);
  }

  @Post('agreements/:id/counter')
  @Roles(UserRole.ADMIN, UserRole.SUPPLIER)
  counter(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: CounterAgreementDto,
  ) {
    return this.commissions.counter(id, body, user);
  }

  @Post('agreements/:id/approve')
  @Roles(UserRole.ADMIN)
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.commissions.approve(id, user);
  }

  @Post('agreements/:id/accept')
  @Roles(UserRole.SUPPLIER)
  accept(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.commissions.accept(id, user);
  }

  @Post('agreements/:id/reject')
  @Roles(UserRole.ADMIN)
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.commissions.reject(id, user);
  }

  @Get('audit')
  @Roles(UserRole.ADMIN)
  audit(
    @CurrentUser() user: AuthUser,
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
  ) {
    return this.commissions.listAudit(
      entityType || 'PlatformSettings',
      entityId || 'default',
      user,
    );
  }

  @Get('admin/supplier-totals')
  @Roles(UserRole.ADMIN)
  adminSupplierTotals(@CurrentUser() user: AuthUser) {
    return this.commissions.listAdminSupplierTotals(user);
  }

  @Get('supplier/summary')
  @Roles(UserRole.SUPPLIER)
  supplierSummary(@CurrentUser() user: AuthUser) {
    return this.commissions.listSupplierCommissionSummary(user);
  }

  @Get('supplier/account')
  @Roles(UserRole.SUPPLIER)
  supplierAccount(@CurrentUser() user: AuthUser) {
    return this.ledger.supplierAccount(user);
  }

  @Get('supplier/receiving-accounts')
  @Roles(UserRole.SUPPLIER)
  supplierReceivingAccounts() {
    return this.ledger.receivingAccounts();
  }

  @Get('supplier/remittances')
  @Roles(UserRole.SUPPLIER)
  supplierRemittances(@CurrentUser() user: AuthUser) {
    return this.ledger.listRemittances(user);
  }

  @Post('supplier/remittances')
  @Roles(UserRole.SUPPLIER)
  submitRemittance(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    return this.ledger.submitRemittance(user, {
      method: String(body.method ?? '') as never,
      claimedAmount: Number(body.claimedAmount),
      claimedCurrency: String(body.claimedCurrency ?? ''),
      reference: String(body.reference ?? ''),
      note: body.note == null ? undefined : String(body.note),
    });
  }

  @Post('supplier/lipa-evidence')
  @Roles(UserRole.SUPPLIER)
  submitLipaEvidence(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    return this.ledger.submitLipaEvidence(user, {
      orderId: String(body.orderId ?? ''),
      reference: String(body.reference ?? ''),
      note: body.note == null ? undefined : String(body.note),
    });
  }

  @Get('admin/accounts')
  @Roles(UserRole.ADMIN)
  adminAccounts(@CurrentUser() user: AuthUser) {
    return this.ledger.adminAccounts(user);
  }

  @Get('admin/remittances')
  @Roles(UserRole.ADMIN)
  adminRemittances(@CurrentUser() user: AuthUser) {
    return this.ledger.listRemittances(user);
  }

  @Get('admin/remittances/:id/fx-preview')
  @Roles(UserRole.ADMIN)
  fxPreview(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ledger.fxPreview(user, id);
  }

  @Post('admin/remittances/:id/verify')
  @Roles(UserRole.ADMIN)
  verifyRemittance(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.ledger.verifyRemittance(user, id, {
      confirmExchange: body.confirmExchange === true,
      fxRate: body.fxRate == null ? undefined : Number(body.fxRate),
      manualAllocations: Array.isArray(body.manualAllocations)
        ? (body.manualAllocations as { snapshotId: string; amount: number }[])
        : undefined,
    });
  }

  @Post('admin/remittances/:id/reject')
  @Roles(UserRole.ADMIN)
  rejectRemittance(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { reviewNote?: string },
  ) {
    return this.ledger.rejectRemittance(user, id, body.reviewNote ?? '');
  }

  @Post('admin/remittances/:id/allocations')
  @Roles(UserRole.ADMIN)
  adjustAllocations(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: {
      apply?: { snapshotId: string; amount: number }[];
      release?: { allocationId: string; amount: number }[];
      autoApply?: boolean;
      reason?: string;
    },
  ) {
    return this.ledger.adjustAllocations(user, id, {
      apply: body.apply,
      release: body.release,
      autoApply: body.autoApply,
      reason: body.reason ?? '',
    });
  }

  @Post('admin/remittances/:id/reverse')
  @Roles(UserRole.ADMIN)
  reverseRemittance(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { reason?: string; providerEventId?: string },
  ) {
    return this.ledger.reverseRemittance(user, id, {
      reason: body.reason ?? '',
      providerEventId: body.providerEventId,
    });
  }

  @Post('admin/receipts')
  @Roles(UserRole.ADMIN)
  adminReceipt(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    return this.ledger.recordAdminReceipt(user, {
      supplierId: String(body.supplierId ?? ''),
      method: String(body.method ?? '') as never,
      claimedAmount: Number(body.claimedAmount),
      claimedCurrency: String(body.claimedCurrency ?? ''),
      reference: String(body.reference ?? ''),
      provider: String(body.provider ?? ''),
      merchantAccountKey: String(body.merchantAccountKey ?? ''),
      note: body.note == null ? undefined : String(body.note),
      confirmExchange: body.confirmExchange === true,
      fxRate: body.fxRate == null ? undefined : Number(body.fxRate),
    });
  }

  @Post('admin/lipa-evidence/:id/verify')
  @Roles(UserRole.ADMIN)
  async verifyLipaEvidence(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const result = await this.ledger.reviewLipaEvidence(user, id, { approve: true });
    if (result.recoveryRequired) {
      await this.recognition.run(result.orderId);
    }
    return result.evidence;
  }

  @Post('admin/recognition/recover')
  @Roles(UserRole.ADMIN)
  async recoverRecognition(
    @CurrentUser() user: AuthUser,
    @Body() body: { orderId?: unknown; supplierId?: unknown } = {},
  ) {
    const orderId = requireRecoveryId(body?.orderId, 'Order id');
    const supplierId =
      body?.supplierId === undefined
        ? undefined
        : requireRecoveryId(body.supplierId, 'Supplier id');
    await this.ledger.assertOrderRecoveryScope(orderId, supplierId);
    return this.recognition.recover(user, orderId);
  }

  @Get('admin/allocations')
  @Roles(UserRole.ADMIN)
  allocationActivity(
    @CurrentUser() user: AuthUser,
    @Query('supplierId') supplierId?: string,
    @Query('remittanceId') remittanceId?: string,
  ) {
    return this.ledger.listAllocationActivity(user, { supplierId, remittanceId });
  }

  @Post('admin/lipa-evidence/:id/reject')
  @Roles(UserRole.ADMIN)
  async rejectLipaEvidence(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { reviewNote?: string },
  ) {
    const result = await this.ledger.reviewLipaEvidence(user, id, {
      approve: false,
      reviewNote: body.reviewNote,
    });
    return result.evidence;
  }

  @Get('admin/held-funds')
  @Roles(UserRole.ADMIN)
  heldFunds(@CurrentUser() user: AuthUser) {
    return this.ledger.heldFunds(user);
  }

  @Get('admin/receiving-accounts')
  @Roles(UserRole.ADMIN)
  receivingAccounts() {
    return this.ledger.receivingAccounts();
  }

  @Post('admin/receiving-accounts')
  @Roles(UserRole.ADMIN)
  updateReceivingAccounts(
    @CurrentUser() user: AuthUser,
    @Body() body: {
      lipaNumber?: string;
      lipaNetwork?: string;
      bankName?: string;
      bankAccountName?: string;
      bankAccountNumber?: string;
    },
  ) {
    return this.ledger.updateReceivingAccounts(user, body);
  }
}
