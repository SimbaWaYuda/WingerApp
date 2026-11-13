import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './auth.types';

export function supplierMayOperate(status: string | null | undefined): boolean {
  const value = (status ?? '').toUpperCase();
  return value === 'APPROVED' || value === 'VERIFIED';
}

@Injectable()
export class ApprovedSupplierGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user || user.role !== UserRole.SUPPLIER) return true;
    if (!user.supplierId) {
      throw new ForbiddenException('Supplier account required');
    }
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: user.supplierId },
      select: { verificationStatus: true },
    });
    if (!supplierMayOperate(supplier?.verificationStatus)) {
      throw new ForbiddenException(
        'Supplier account is waiting for Winger approval',
      );
    }
    return true;
  }
}
