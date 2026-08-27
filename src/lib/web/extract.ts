import { stripHtml } from '@/lib/documents/parse';

/**
 * Pull the readable part out of a web page.
 *
 * Not a full readability implementation, and deliberately so: the goal is to
 * get the article text into a prompt without the navigation, cookie banner and
 * footer link farm that would otherwise consume most of the budget and give the
 * model a page of menu items to reason about.
 *
 * The approach is to prefer an explicit content container when the page has
 * one, and otherwise strip the known-chrome elements and take what is left.
 */

export interface ReadablePage {
  title: string | null;
  description: string | null;
  text: string;
  /** Canonical URL when the page declares one, so caching can dedupe. */
  canonical: string | null;
}

/** Elements that are never article content. */
const CHROME_TAGS = ['nav', 'header', 'footer', 'aside', 'form', 'menu', 'dialog'];

/** Containers that usually hold the article, in descending order of confidence. */
const CONTENT_PATTERNS = [
  /<article\b[^>]*>([\s\S]*?)<\/article>/i,
  /<main\b[^>]*>([\s\S]*?)<\/main>/i,
  /<div[^>]*\brole=["']main["'][^>]*>([\s\S]*?)<\/div>/i,
];

export function extractReadable(html: string, sourceUrl: string): ReadablePage {
  const title = firstMatch(html, [
    /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
  ]);

  const description = firstMatch(html, [
    /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i,
    /<meta\s+property=["']og:description["']\s+content=["']([^"']*)["']/i,
  ]);

  const canonicalRaw = firstMatch(html, [
    /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i,
  ]);

  let canonical: string | null = null;
  if (canonicalRaw) {
    try {
      canonical = new URL(canonicalRaw, sourceUrl).toString();
    } catch {
      // A malformed canonical link is not worth failing an extraction over.
    }
  }

  const body = pickContent(html);
  const { text } = stripHtml(removeChrome(body));

  return {
    title: title ? decodeEntities(title).slice(0, 300) : null,
    description: description ? decodeEntities(description).slice(0, 600) : null,
    text: tidy(text),
    canonical,
  };
}

/**
 * Choose the region of the page to read.
 *
 * A candidate is only accepted if it is substantial: some sites wrap a "skip to
 * content" link in `<main>`, and taking that over the real body would be worse
 * than taking the whole page.
 */
function pickContent(html: string): string {
  for (const pattern of CONTENT_PATTERNS) {
    const candidate = pattern.exec(html)?.[1];
    if (candidate && stripHtml(candidate).text.length >= 200) {
      return candidate;
    }
  }

  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1];
  return body ?? html;
}

function removeChrome(html: string): string {
  let result = html;
  for (const tag of CHROME_TAGS) {
    result = result.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
  }
  // Cookie and consent banners are usually divs, identified by class or id.
  result = result.replace(
    /<div[^>]*\b(?:class|id)=["'][^"']*(?:cookie|consent|gdpr|newsletter|subscribe|paywall|advert)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    ' ',
  );
  return result;
}

function firstMatch(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const value = pattern.exec(html)?.[1]?.trim();
    if (value && value.length > 0) return value;
  }
  return null;
}

function decodeEntities(text: string): string {
  return stripHtml(text).text.trim();
}

/**
 * Collapse the whitespace that stripping tags leaves behind, and drop the
 * one-word lines that are the residue of link lists.
 */
function tidy(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const kept: string[] = [];
  for (const line of lines) {
    // A very short line that is not a heading or list item is almost always a
    // leftover menu entry rather than prose.
    if (line.length < 3 && !/^[-•]/.test(line)) continue;
    kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
