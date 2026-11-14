import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { business, resources } from './schema.js';

export const DEMO_BUSINESS_NAME = 'Estudio Demo';

/** Idempotent: re-running leaves a single demo business and resource. */
export async function seedDemo(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await tx.select({ id: business.id }).from(business).where(eq(business.name, DEMO_BUSINESS_NAME));
    if (existing.length > 0) return;
    const [created] = await tx
      .insert(business)
      .values({
        name: DEMO_BUSINESS_NAME,
        serviceName: 'Consulta',
        serviceMinutes: 45,
        depositMinor: 1,
        slotMinutes: 45,
        hours: { open: '09:00', close: '19:00' },
      })
      .returning({ id: business.id });
    if (!created) throw new Error('Seed insert returned no row');
    await tx.insert(resources).values({ businessId: created.id, name: 'Consultorio 1' });
  });
}
