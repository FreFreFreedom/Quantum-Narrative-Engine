// Type declarations for unconverted JS modules
// This allows TypeScript to compile while we incrementally convert

declare module './realtime.js' {
  export function attachRealtime(server: any, pool: any): void;
}

declare module './routes/queue.js' {
  export const queueRoutes: any;
}

declare module './routes/agents.js' {
  export const agentsRoutes: any;
}

declare module './routes/ontology.js' {
  export const ontologyRoutes: any;
}

declare module './routes/chat.js' {
  export const chatRoutes: any;
}

declare module './services/promptQueue.js' {
  export function bindDb(pool: any): void;
  export function initPromptQueue(pool: any): void;
}

declare module './services/agents.js' {
  export function bindAgentsDb(pool: any): void;
}

declare module './services/bootstrapData.js' {
  export async function migrateOntology(pool: any): Promise<any>;
  export async function seedKnowledge(pool: any): Promise<any>;
  export async function seedArchitectureHistory(pool: any): Promise<any>;
  export async function cleanupFrenchSuggestions(pool: any): Promise<any>;
}

declare module './services/taskRunner.js' {
  export function initTaskRunner(pool: any): void;
  export function bindTaskDb(pool: any): void;
  export const DATA_DIR: string;
}

declare module './routes/architecture.js' {
  export const architectureRoutes: any;
}

declare module './routes/intel.js' {
  export const intelRoutes: any;
}

declare module './routes/discovery.js' {
  export const discoveryRoutes: any;
}

declare module './services/warmup.js' {
  export function warmCaches(pool: any): void;
}

declare module './services/preGen.js' {
  export function startPreGen(pool: any): void;
}

declare module './services/books.js' {
  export function makeBooksHandler(pool: any): any;
}

declare module './services/tagLens.js' {
  export function makeTagLensHandler(pool: any): any;
}

declare module './routes/travaux.js' {
  export const travauxRoutes: any;
}

declare module './routes/worker.js' {
  export const workerRoutes: any;
}

declare module './routes/reviews.js' {
  export const reviewsRoutes: any;
}

declare module './services/workSuggestions.js' {
  export function bindWorkSuggestionsDb(pool: any): void;
}

declare module './services/workIdeas.js' {
  export function bindWorkIdeasDb(pool: any): void;
}

declare module './services/reviewRunner.js' {
  export function bindReviewsDb(pool: any): void;
}

declare module './services/briefing.js' {
  export function bindBriefingDb(pool: any): void;
  export function regenerateBriefing(pool: any): Promise<void>;
}

declare module './services/claudeUsage.js' {
  export function getClaudeUsage(): any;
}

declare module './services/ai/text.js' {
  export function bindAiTextDb(pool: any): void;
  export function migrateFreeFirstDefaults(): { changed: number };
}

declare module './services/ai/router.js' {
  export function bindRouterDb(pool: any): void;
  export function earliestResetAt(): Date | null;
}

declare module './services/quotaScheduler.js' {
  export function startQuotaScheduler(pool: any): void;
  export function bindQuotaSchedulerDb(pool: any): void;
}

declare module './routes/providers.js' {
  export const providersRoutes: any;
}

declare module './routes/conversations.js' {
  export const conversationsRoutes: any;
}

declare module './services/conversations.js' {
  export function bindConversationsDb(pool: any): void;
}

declare module './services/textCallRegistry.js' {
  export function killTextCalls(): void;
  export function activeTextCallCount(): number;
}

declare module './lib/asyncHandler.js' {
  export function asyncHandler(fn: any): any;
  export const errorHandler: any;
}// Express type extensions for Passport
// Place this in a declaration file to extend Express types

import { User } from '../services/auth.js';

declare global {
  namespace Express {
    interface User {
      id: string;
      name: string;
      email?: string;
      avatar_url?: string;
      provider: 'password' | 'google' | 'github';
      provider_id?: string;
      created_at: Date;
    }
  }
}

export {};