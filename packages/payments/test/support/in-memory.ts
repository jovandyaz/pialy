import type {
  AttemptLookup,
  NewPaymentEvent,
  PaymentAttempt,
  PaymentEvent,
  PaymentIntent,
  UnitOfWork,
  UnitOfWorkContext,
  WebhookOutcome,
} from '../../src/index.js';

export interface InboxRow {
  readonly eventType: string;
  readonly outcome: WebhookOutcome | null;
}

export interface StoreState {
  intents: Map<string, PaymentIntent>;
  attempts: Map<string, PaymentAttempt>;
  events: NewPaymentEvent[];
  inbox: Map<string, InboxRow>;
  reactions: PaymentEvent[];
}

export interface InMemoryStore {
  readonly state: StoreState;
  readonly uow: UnitOfWork;
  /** True while a unit of work is open. */
  readonly inTransaction: () => boolean;
}

type Reaction = (event: PaymentEvent) => Promise<void>;

function emptyState(): StoreState {
  return { intents: new Map(), attempts: new Map(), events: [], inbox: new Map(), reactions: [] };
}

function copyState(s: StoreState): StoreState {
  return {
    intents: new Map(s.intents),
    attempts: new Map(s.attempts),
    events: [...s.events],
    inbox: new Map(s.inbox),
    reactions: [...s.reactions],
  };
}

function matchesLookup(attempt: PaymentAttempt, lookup: AttemptLookup): boolean {
  if ('transactionId' in lookup) return attempt.provider.transactionId === lookup.transactionId;
  if ('qrId' in lookup) return attempt.provider.qrId === lookup.qrId;
  return attempt.id === lookup.attemptId;
}

/** Transactional in memory: a unit of work that throws leaves the state as it found it. */
export function inMemoryStore(reaction: Reaction = () => Promise.resolve()): InMemoryStore {
  let state = emptyState();
  let open = 0;

  function context(): UnitOfWorkContext {
    return {
      payments: {
        findAttemptByRef(lookup) {
          const attempt = [...state.attempts.values()].find((a) => matchesLookup(a, lookup));
          const intent = attempt && state.intents.get(attempt.intentId);
          return Promise.resolve(attempt && intent ? { intent, attempt } : null);
        },
        hasOtherAwaiting(intentId, exceptAttemptId) {
          return Promise.resolve(
            [...state.attempts.values()].some(
              (a) => a.intentId === intentId && a.id !== exceptAttemptId && a.status === 'awaiting',
            ),
          );
        },
        insertPaymentEvent(event) {
          if (state.events.some((e) => e.providerTxId === event.providerTxId)) {
            return Promise.resolve('duplicate');
          }
          state.events.push(event);
          return Promise.resolve('inserted');
        },
        saveIntent(intent) {
          state.intents.set(intent.id, intent);
          return Promise.resolve();
        },
        saveAttempt(attempt) {
          state.attempts.set(attempt.id, attempt);
          return Promise.resolve();
        },
      },
      inbox: {
        insert({ webhookId, eventType }) {
          if (state.inbox.has(webhookId)) return Promise.resolve('duplicate');
          state.inbox.set(webhookId, { eventType, outcome: null });
          return Promise.resolve('inserted');
        },
        markProcessed(webhookId, outcome) {
          const row = state.inbox.get(webhookId);
          if (!row) return Promise.reject(new Error(`no inbox row ${webhookId}`));
          state.inbox.set(webhookId, { ...row, outcome });
          return Promise.resolve();
        },
      },
      async bookingEvents(event) {
        state.reactions.push(event);
        await reaction(event);
      },
    };
  }

  return {
    get state() {
      return state;
    },
    inTransaction: () => open > 0,
    uow: {
      async run(fn) {
        const before = copyState(state);
        open += 1;
        try {
          return await fn(context());
        } catch (error) {
          state = before;
          throw error;
        } finally {
          open -= 1;
        }
      },
    },
  };
}
