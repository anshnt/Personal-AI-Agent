import { describe, expect, it } from 'vitest';

import { extractReadable } from './extract';

const page = `<html><head>
  <title>Tide tables</title>
  <meta name="description" content="When the water moves">
  <link rel="canonical" href="/today">
  <style>nav{display:none}</style>
  <script>track()</script>
</head><body>
  <nav>Home About Contact</nav>
  <div class="cookie-banner">We use cookies. Accept?</div>
  <article>
    <h1>Tide tables</h1>
    <p>High water at 06:12 and 18:34.</p>
    <p>The harbour closes at low water.</p>
  </article>
  <footer>Copyright someone 2026</footer>
</body></html>`;

describe('extractReadable', () => {
  const result = extractReadable(page, 'https://tides.example/today');

  it('extracts the title', () => {
    expect(result.title).toBe('Tide tables');
  });

  it('extracts the description', () => {
    expect(result.description).toBe('When the water moves');
  });

  it('resolves a relative canonical link', () => {
    expect(result.canonical).toBe('https://tides.example/today');
  });

  it('keeps the article text', () => {
    expect(result.text).toContain('High water at 06:12');
    expect(result.text).toContain('The harbour closes at low water.');
  });

  it('drops navigation, cookie banners, and footers', () => {
    expect(result.text).not.toContain('Home About Contact');
    expect(result.text).not.toContain('We use cookies');
    expect(result.text).not.toContain('Copyright someone');
  });

  it('drops script and style content', () => {
    expect(result.text).not.toContain('track()');
    expect(result.text).not.toContain('display:none');
  });

  it('falls back to the body when there is no content container', () => {
    const bare = extractReadable('<body><p>Just a paragraph in a bare body.</p></body>', 'https://x.example/');
    expect(bare.text).toContain('Just a paragraph');
  });

  it('ignores a content container that is too thin to be the article', () => {
    // Some sites wrap a "skip to content" link in <main>; taking that over the
    // real body would be worse than taking the whole page.
    const html = `<body><main><a href="#c">Skip to content</a></main>
      <div><p>${'The actual article text goes on for a while. '.repeat(10)}</p></div></body>`;
    expect(extractReadable(html, 'https://x.example/').text).toContain('The actual article text');
  });

  it('prefers og:title over the title tag', () => {
    const html = `<head><meta property="og:title" content="Better title"><title>Worse title</title></head><body><p>x</p></body>`;
    expect(extractReadable(html, 'https://x.example/').title).toBe('Better title');
  });

  it('decodes numeric entities and drops out-of-range ones', () => {
    expect(extractReadable('<body><p>&#8212;dash</p></body>', 'https://x.example/').text).toContain('—');
    expect(extractReadable('<body><p>&#999999999;kept</p></body>', 'https://x.example/').text).toContain('kept');
  });

  it('does not hang on unclosed tags', () => {
    expect(extractReadable('<div><p>text', 'https://x.example/').text).toContain('text');
  });

  it('survives a malformed canonical link', () => {
    const html = '<head><link rel="canonical" href="ht tp://broken"></head><body><p>x</p></body>';
    expect(() => extractReadable(html, 'https://x.example/')).not.toThrow();
  });

  it('returns empty text rather than throwing on empty input', () => {
    expect(extractReadable('', 'https://x.example/').text).toBe('');
  });
});
