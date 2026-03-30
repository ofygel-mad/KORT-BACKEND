import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load test environment variables
config({ path: resolve('.env.test') });

// Global test hooks
beforeAll(async () => {
  console.log('🧪 Test suite started');
  // Setup any global test resources here
});

afterAll(async () => {
  console.log('✅ Test suite completed');
  // Cleanup global test resources here
});

beforeEach(async () => {
  // Setup before each test
});

afterEach(async () => {
  // Cleanup after each test
});

// Mock console in test mode
if (process.env.NODE_ENV === 'test') {
  global.console = {
    ...console,
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: console.warn,
    error: console.error,
  };
}
