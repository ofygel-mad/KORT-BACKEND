import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: ['error'],  // 'warn' generates noise on every slow query in dev; errors only
});

export async function connectDatabase() {
  await prisma.$connect();
}

export async function disconnectDatabase() {
  await prisma.$disconnect();
}
