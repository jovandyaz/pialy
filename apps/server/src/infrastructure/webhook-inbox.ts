import { InsertResult, type Inbox } from '@pialy/payments';
import { eq, sql } from 'drizzle-orm';
import type { DbTx } from './db/client.js';
import { webhookInbox } from './db/schema.js';

export function createWebhookInbox(tx: DbTx): Inbox {
  return {
    async insert({ webhookId, eventType }) {
      const inserted = await tx
        .insert(webhookInbox)
        .values({ webhookId, eventType })
        .onConflictDoNothing({ target: webhookInbox.webhookId })
        .returning({ webhookId: webhookInbox.webhookId });
      return inserted.length === 0 ? InsertResult.Duplicate : InsertResult.Inserted;
    },

    async markProcessed(webhookId, outcome) {
      const updated = await tx
        .update(webhookInbox)
        .set({ processedAt: sql`now()`, outcome })
        .where(eq(webhookInbox.webhookId, webhookId))
        .returning({ webhookId: webhookInbox.webhookId });
      if (updated.length === 0) throw new Error(`webhook ${webhookId} is not in the inbox`);
    },
  };
}
