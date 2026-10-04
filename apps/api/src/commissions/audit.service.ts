import { Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(params: {
    entityType: string;
    entityId: string;
    action: string;
    actorUserId: string;
    actorRole: UserRole;
    before?: unknown;
    after?: unknown;
    tx?: Prisma.TransactionClient;
  }) {
    const client = params.tx ?? this.prisma;
    return client.auditLog.create({
      data: {
        entityType: params.entityType,
        entityId: params.entityId,
        action: params.action,
        actorUserId: params.actorUserId,
        actorRole: params.actorRole,
        beforeJson:
          params.before === undefined
            ? undefined
            : (params.before as Prisma.InputJsonValue),
        afterJson:
          params.after === undefined
            ? undefined
            : (params.after as Prisma.InputJsonValue),
      },
    });
  }

  async listForEntity(entityType: string, entityId: string) {
    return this.prisma.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
