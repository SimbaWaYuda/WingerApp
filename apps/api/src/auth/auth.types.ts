import { UserRole } from '@prisma/client';

export type JwtPayload = {
  sub: string;
  email: string;
  role: UserRole;
  supplierId?: string | null;
  name: string;
};

export type AuthUser = JwtPayload;
