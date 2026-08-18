// Vitest test setup
import { vi } from 'vitest';

// Mock external services
vi.mock('../server/src/services/claudeText.js', () => ({
  generateText: vi.fn().mockResolvedValue({ text: '{"queries":[],"picks":[]}' }),
}));

vi.mock('../server/src/services/ai/text.js', () => ({
  generateText: vi.fn().mockResolvedValue({ text: '{}' }),
  generateTextByFeature: vi.fn().mockResolvedValue({ text: '{}' }),
}));

vi.mock('../server/src/services/ai/providers.js', () => ({
  listModelsForProvider: vi.fn().mockResolvedValue([]),
  getProvider: vi.fn(),
}));

vi.mock('../server/src/services/codeDiscovery.js', () => ({
  runWorldLookGuarded: vi.fn().mockResolvedValue({ running: false, report: null }),
  findReportBySource: vi.fn().mockResolvedValue(null),
  isWorldLookRunning: vi.fn().mockReturnValue(false),
}));

vi.mock('../server/src/services/taskPlanner.js', () => ({
  draftPlan: vi.fn().mockResolvedValue({ plan: 'test plan' }),
}));

// Mock the database pool
vi.mock('../server/src/db/pool.js', () => {
  const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const mockConnect = vi.fn().mockResolvedValue({
    query: mockQuery,
    release: vi.fn(),
  });
  
  return {
    pool: {
      query: mockQuery,
      connect: mockConnect,
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    },
    query: mockQuery,
    getClient: mockConnect,
    transaction: vi.fn(async (fn) => fn({ query: mockQuery, release: vi.fn() })),
    checkConnection: vi.fn().mockResolvedValue(true),
    closePool: vi.fn().mockResolvedValue(undefined),
  };
});

// Extend test timeout
vi.setConfig({ testTimeout: 30000 });