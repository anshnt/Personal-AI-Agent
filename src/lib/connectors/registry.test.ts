import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  allConnectors,
  availableConnectors,
  findConnector,
  isConfigured,
  resetRegistry,
} from './registry';
import { ConnectorError } from './types';

/**
 * Registry construction, including the configuration-defined connectors.
 *
 * Pure: no request is made, so this is about which connectors exist, whether
 * they are usable, and that a bad configuration fails loudly.
 */

const ENV_KEYS = ['CUSTOM_CONNECTORS', 'GITHUB_TOKEN', 'HOUSE_TOKEN'];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  resetRegistry();
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetRegistry();
});

describe('built-in connectors', () => {
  it('registers the expected set', () => {
    const names = allConnectors().map((connector) => connector.name);
    expect(names).toContain('weather');
    expect(names).toContain('geocoding');
    expect(names).toContain('currency');
    expect(names).toContain('github');
  });

  it('uses https everywhere', () => {
    for (const connector of allConnectors()) {
      expect(connector.baseUrl.startsWith('https://'), connector.name).toBe(true);
    }
  });

  it('gives every operation a description the model can choose by', () => {
    for (const connector of allConnectors()) {
      for (const operation of connector.operations) {
        expect(operation.description.length, `${connector.name}.${operation.name}`).toBeGreaterThan(10);
      }
    }
  });

  it('gives every connector a rate limit', () => {
    for (const connector of allConnectors()) {
      expect(connector.rateLimit.calls, connector.name).toBeGreaterThan(0);
      expect(connector.rateLimit.windowSeconds, connector.name).toBeGreaterThan(0);
    }
  });

  it('exposes no write on any keyless connector', () => {
    // A connector needing no credential is one anybody could have configured,
    // so it should not be able to change anything.
    for (const connector of allConnectors().filter((entry) => entry.auth.kind === 'none')) {
      for (const operation of connector.operations) {
        expect(operation.mutates, `${connector.name}.${operation.name}`).not.toBe(true);
      }
    }
  });

  it('marks the one write it does have', () => {
    const writes = findConnector('github')?.operations.filter((operation) => operation.mutates) ?? [];
    expect(writes.map((operation) => operation.name)).toEqual(['create_issue']);
  });

  it('declares a setup hint for anything needing a credential', () => {
    for (const connector of allConnectors().filter((entry) => entry.auth.kind !== 'none')) {
      expect(connector.setupHint, connector.name).toBeTruthy();
    }
  });
});

describe('availability', () => {
  it('makes keyless connectors available with no configuration', () => {
    for (const name of ['weather', 'geocoding', 'currency']) {
      const connector = findConnector(name);
      expect(connector && isConfigured(connector), name).toBe(true);
    }
  });

  it('withholds a connector whose credential is missing', () => {
    const github = findConnector('github');
    expect(github && isConfigured(github)).toBe(false);
    expect(availableConnectors().map((entry) => entry.name)).not.toContain('github');
  });

  it('treats a blank credential as missing', () => {
    process.env.GITHUB_TOKEN = '   ';
    resetRegistry();
    const github = findConnector('github');
    expect(github && isConfigured(github)).toBe(false);
  });

  it('makes it available once the credential is set', () => {
    process.env.GITHUB_TOKEN = 'ghp_example';
    resetRegistry();
    const github = findConnector('github');
    expect(github && isConfigured(github)).toBe(true);
    expect(availableConnectors().map((entry) => entry.name)).toContain('github');
  });
});

describe('custom connectors from configuration', () => {
  const definition = [
    {
      name: 'house',
      description: 'A home automation API.',
      baseUrl: 'https://house.example.com',
      auth: { kind: 'header', envVar: 'HOUSE_TOKEN', header: 'X-Api-Key' },
      rateLimit: { calls: 10, windowSeconds: 600 },
      operations: [
        {
          name: 'read_sensor',
          description: 'Read a named sensor by its identifier.',
          method: 'GET',
          path: '/sensors/{id}',
          params: { id: { required: true, description: 'Sensor id' } },
        },
      ],
    },
  ];

  it('registers a connector declared in configuration', () => {
    process.env.CUSTOM_CONNECTORS = JSON.stringify(definition);
    resetRegistry();
    const house = findConnector('house');
    expect(house).toBeDefined();
    expect(house?.rateLimit.calls).toBe(10);
    expect(house?.operations[0]?.name).toBe('read_sensor');
  });

  it('gates it on its declared credential', () => {
    process.env.CUSTOM_CONNECTORS = JSON.stringify(definition);
    resetRegistry();
    expect(isConfigured(findConnector('house')!)).toBe(false);
    process.env.HOUSE_TOKEN = 'a-secret';
    expect(isConfigured(findConnector('house')!)).toBe(true);
  });

  it('rejects an undeclared parameter', () => {
    // Otherwise an undeclared value is forwarded to somebody's API unchecked.
    process.env.CUSTOM_CONNECTORS = JSON.stringify(definition);
    resetRegistry();
    const input = findConnector('house')!.operations[0]!.input;
    expect(input.safeParse({ id: 'kitchen' }).success).toBe(true);
    expect(input.safeParse({ id: 'kitchen', extra: 'x' }).success).toBe(false);
  });

  it('requires a declared-required parameter', () => {
    process.env.CUSTOM_CONNECTORS = JSON.stringify(definition);
    resetRegistry();
    const input = findConnector('house')!.operations[0]!.input;
    expect(input.safeParse({}).success).toBe(false);
  });

  it('reports malformed JSON clearly', () => {
    process.env.CUSTOM_CONNECTORS = '{ not json';
    resetRegistry();
    expect(() => allConnectors()).toThrow(ConnectorError);
    expect(() => allConnectors()).toThrow(/not valid JSON/);
  });

  it('reports an invalid definition clearly', () => {
    process.env.CUSTOM_CONNECTORS = JSON.stringify([
      { name: 'Bad Name', description: 'x', baseUrl: 'not-a-url', operations: [] },
    ]);
    resetRegistry();
    expect(() => allConnectors()).toThrow(/not a valid connector list/);
  });

  it('rejects a connector name that is not a safe identifier', () => {
    process.env.CUSTOM_CONNECTORS = JSON.stringify([
      {
        ...definition[0],
        name: 'has spaces',
      },
    ]);
    resetRegistry();
    expect(() => allConnectors()).toThrow(/not a valid connector list/);
  });

  it('defaults to no auth when none is declared', () => {
    process.env.CUSTOM_CONNECTORS = JSON.stringify([
      {
        name: 'open',
        description: 'A public API.',
        baseUrl: 'https://open.example.com',
        operations: [
          { name: 'ping', description: 'Check that it is up.', method: 'GET', path: '/ping' },
        ],
      },
    ]);
    resetRegistry();
    const open = findConnector('open');
    expect(open?.auth.kind).toBe('none');
    expect(open && isConfigured(open)).toBe(true);
  });
});
