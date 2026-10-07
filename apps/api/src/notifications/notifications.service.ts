import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhoneE164, toWhatsAppAddress } from './whatsapp.util';

export type NotifyCustomerInput = {
  userId: string;
  type: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  get whatsappConfigured(): boolean {
    return Boolean(
      process.env.TWILIO_ACCOUNT_SID?.trim() &&
        process.env.TWILIO_AUTH_TOKEN?.trim() &&
        process.env.TWILIO_WHATSAPP_FROM?.trim(),
    );
  }

  async listForUser(userId: string, take = 50) {
    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(take, 1), 100),
    });
    const unreadCount = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    return {
      unreadCount,
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        entityType: row.entityType,
        entityId: row.entityId,
        readAt: row.readAt?.toISOString() ?? null,
        whatsappStatus: row.whatsappStatus,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    return { unreadCount: count };
  }

  async markRead(userId: string, id: string) {
    const row = await this.prisma.notification.findFirst({
      where: { id, userId },
    });
    if (!row) return null;
    if (row.readAt) {
      return {
        id: row.id,
        readAt: row.readAt.toISOString(),
      };
    }
    const updated = await this.prisma.notification.update({
      where: { id: row.id },
      data: { readAt: new Date() },
    });
    return {
      id: updated.id,
      readAt: updated.readAt!.toISOString(),
    };
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  /**
   * Persist in-app notification and optionally send WhatsApp via Twilio.
   * Never throws — return/refund updates must not fail on notify errors.
   */
  async notifyCustomer(input: NotifyCustomerInput) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true, phone: true, name: true },
      });
      if (!user) {
        this.logger.warn(`notifyCustomer: user ${input.userId} not found`);
        return null;
      }

      const whatsappStatus = await this.sendWhatsAppSafe(
        user.phone,
        `${input.title}\n\n${input.body}`,
      );

      return await this.prisma.notification.create({
        data: {
          userId: user.id,
          type: input.type,
          title: input.title,
          body: input.body,
          entityType: input.entityType,
          entityId: input.entityId,
          whatsappStatus,
        },
      });
    } catch (error) {
      this.logger.warn(
        `notifyCustomer failed: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  async notifyReturnStatusChange(params: {
    customerId: string;
    returnId: string;
    orderDisplayId: string;
    productName: string;
    status?: string;
    refundStatus?: string;
  }) {
    const messages: Array<{ type: string; title: string; body: string }> = [];
    if (params.status) {
      const msg = returnStatusMessage(
        params.status,
        params.orderDisplayId,
        params.productName,
      );
      if (msg) messages.push(msg);
    }
    if (params.refundStatus) {
      const msg = refundStatusMessage(
        params.refundStatus,
        params.orderDisplayId,
        params.productName,
      );
      if (msg) messages.push(msg);
    }
    for (const msg of messages) {
      await this.notifyCustomer({
        userId: params.customerId,
        type: msg.type,
        title: msg.title,
        body: msg.body,
        entityType: 'ReturnRequest',
        entityId: params.returnId,
      });
    }
  }

  private async sendWhatsAppSafe(
    phoneRaw: string | null | undefined,
    body: string,
  ): Promise<string> {
    const phone = normalizePhoneE164(phoneRaw);
    if (!phone) return 'whatsapp_skipped';

    if (!this.whatsappConfigured) {
      this.logger.log(
        `[whatsapp:noop] to=${phone} body=${JSON.stringify(body.slice(0, 200))}`,
      );
      return 'whatsapp_noop';
    }

    const sid = process.env.TWILIO_ACCOUNT_SID!.trim();
    const token = process.env.TWILIO_AUTH_TOKEN!.trim();
    const from = toWhatsAppAddress(process.env.TWILIO_WHATSAPP_FROM!.trim());
    const to = toWhatsAppAddress(phone);
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
      });
      if (!response.ok) {
        const text = await response.text();
        this.logger.warn(`WhatsApp send failed (${response.status}): ${text}`);
        return 'whatsapp_failed';
      }
      return 'whatsapp_sent';
    } catch (error) {
      this.logger.warn(
        `WhatsApp send error: ${error instanceof Error ? error.message : error}`,
      );
      return 'whatsapp_failed';
    }
  }
}

export function returnStatusMessage(
  status: string,
  orderDisplayId: string,
  productName: string,
): { type: string; title: string; body: string } | null {
  switch (status) {
    case 'IN_REVIEW':
      return {
        type: 'RETURN_IN_REVIEW',
        title: 'Return under review',
        body: `Your return for ${productName} on order ${orderDisplayId} is being reviewed.`,
      };
    case 'APPROVED':
      return {
        type: 'RETURN_APPROVED',
        title: 'Return approved',
        body: `Your return for ${productName} on order ${orderDisplayId} was approved. Refund tracking will update next.`,
      };
    case 'REJECTED':
      return {
        type: 'RETURN_REJECTED',
        title: 'Return declined',
        body: `Your return for ${productName} on order ${orderDisplayId} was declined.`,
      };
    case 'CLOSED':
      return {
        type: 'RETURN_CLOSED',
        title: 'Return closed',
        body: `Your return for ${productName} on order ${orderDisplayId} is now closed.`,
      };
    default:
      return null;
  }
}

export function refundStatusMessage(
  refundStatus: string,
  orderDisplayId: string,
  productName: string,
): { type: string; title: string; body: string } | null {
  switch (refundStatus) {
    case 'ISSUED':
      return {
        type: 'REFUND_ISSUED',
        title: 'Refund issued',
        body: `A refund for ${productName} on order ${orderDisplayId} has been marked as issued.`,
      };
    case 'NOT_REQUIRED':
      return {
        type: 'REFUND_NOT_REQUIRED',
        title: 'No refund needed',
        body: `No refund is required for ${productName} on order ${orderDisplayId}.`,
      };
    case 'PENDING':
      return {
        type: 'REFUND_PENDING',
        title: 'Refund pending',
        body: `A refund for ${productName} on order ${orderDisplayId} is pending.`,
      };
    default:
      return null;
  }
}
