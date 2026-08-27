import { describe, expect, it } from 'vitest';

import { UnsafeUrlError, isBlockedAddress, screenUrl } from './guard';

/**
 * The SSRF guard's decidable half. Everything here is pure, so it runs with no
 * network — which is what makes it worth having separately from the integration
 * checks in scripts/smoke-web.ts, where a real socket is involved.
 */

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback, non-canonical'],
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private, lower bound'],
    ['172.31.255.255', 'private, upper bound'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'AWS, Azure and GCP instance metadata'],
    ['100.100.100.200', 'Alibaba metadata'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['192.88.99.1', '6to4 relay anycast'],
    ['198.18.0.1', 'benchmarking'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
  ])('blocks %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fec0::1', 'site-local'],
    ['fd00::1', 'unique local'],
    ['fc00::1', 'unique local'],
    ['ff02::1', 'multicast'],
    ['64:ff9b::1', 'NAT64'],
    ['100::1', 'discard-only'],
    ['2001:db8::1', 'documentation'],
  ])('blocks IPv6 %s (%s)', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it('blocks IPv4-mapped IPv6, which is how a v4 address gets past a v4-only check', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
    // The hex form of the same thing.
    expect(isBlockedAddress('::ffff:7f00:1')).toBe(true);
  });

  it('blocks anything that is not an IP literal', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
    expect(isBlockedAddress('1.2.3')).toBe(true);
    expect(isBlockedAddress('999.1.1.1')).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])(
    'allows the ordinary public address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  // An off-by-one here either opens a hole or breaks real sites, so the
  // addresses either side of each private block are pinned.
  it.each(['172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '11.0.0.1', '9.255.255.255'])(
    'treats %s as public, just outside a private range',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('screenUrl', () => {
  it.each([
    'file:///etc/passwd',
    'gopher://example.com/',
    'data:text/html,<b>x</b>',
    'ftp://example.com/',
    'ws://example.com/',
  ])('refuses the scheme in %s', (url) => {
    expect(() => screenUrl(url)).toThrow(UnsafeUrlError);
  });

  it('refuses a string that is not a URL', () => {
    expect(() => screenUrl('not a url')).toThrow(UnsafeUrlError);
    expect(() => screenUrl('')).toThrow(UnsafeUrlError);
  });

  it('refuses names that mean this machine', () => {
    for (const host of ['localhost', 'db.localhost', 'metadata.internal', 'box.local', 'x.localdomain']) {
      expect(() => screenUrl(`http://${host}/`), host).toThrow(UnsafeUrlError);
    }
  });

  it('refuses private and metadata addresses given as literals', () => {
    expect(() => screenUrl('http://127.0.0.1:8080/')).toThrow(UnsafeUrlError);
    expect(() => screenUrl('http://169.254.169.254/latest/meta-data/')).toThrow(UnsafeUrlError);
    expect(() => screenUrl('http://[::1]/')).toThrow(UnsafeUrlError);
    expect(() => screenUrl('http://10.0.0.5:8443/admin')).toThrow(UnsafeUrlError);
  });

  it('refuses embedded credentials', () => {
    // The classic disguise: this connects to 127.0.0.1, not to google.
    expect(() => screenUrl('https://www.google.com@127.0.0.1/')).toThrow(UnsafeUrlError);
    expect(() => screenUrl('http://user:pw@example.com/')).toThrow(UnsafeUrlError);
  });

  it.each([22, 25, 3306, 5432, 6379, 9200, 11211])('refuses port %d', (port) => {
    expect(() => screenUrl(`http://example.com:${port}/`)).toThrow(UnsafeUrlError);
  });

  it.each([80, 443, 8080, 8443])('allows port %d', (port) => {
    // `URL` normalises a scheme's default port away, so the assertion is that
    // screening accepted the URL, not that the port survived verbatim.
    expect(() => screenUrl(`http://example.com:${port}/path`)).not.toThrow();
  });

  it('allows an ordinary public URL and preserves it', () => {
    const url = screenUrl('https://example.com/a/b?c=d#e');
    expect(url.hostname).toBe('example.com');
    expect(url.pathname).toBe('/a/b');
    expect(url.search).toBe('?c=d');
  });
});
