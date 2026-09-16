import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('config', () => {
  test('should load config from file', () => {
    const config = JSON.parse(
      readFileSync(join(process.cwd(), 'config.json'), 'utf-8')
    );
    assert.ok(config.server);
    assert.ok(config.server.port);
    assert.ok(config.cheap);
    assert.ok(config.balanced);
    assert.ok(config.auto);
  });

  test('should have correct defaults', () => {
    const config = JSON.parse(
      readFileSync(join(process.cwd(), 'config.json'), 'utf-8')
    );
    assert.strictEqual(config.server.port, 4000);
    assert.strictEqual(config.catalog.refreshIntervalSeconds, 300);
    assert.strictEqual(config.auto.costTier, 'low');
  });
});
