// Utilities for handling MangaFire's URL/id formats.
//
// MangaFire migrated from the legacy format
//   https://mangafire.to/manga/{slug}.{id}      e.g. /manga/one-piecee.dkw
// to the current format
//   https://mangafire.to/title/{id}-{slug}      e.g. /title/lx8vq-reborn-as-the-overpowered-genius-lord
//
// All public endpoints accept ANY of these forms:
//   - full URL (either format)
//   - "lx8vq-reborn-as-the-overpowered-genius-lord"   (current slug)
//   - "reborn-as-the-overpowered-genius-lord.lx8vq"   (legacy slug)
//   - "lx8vq"                                          (bare id)

export interface ParsedMangaRef {
  /** Bare manga id used by the /ajax/* endpoints, e.g. "lx8vq" */
  id: string;
  /** URL slug without the id, when known */
  slug: string | null;
  /** Canonical path for the manga info page */
  pagePath: string;
}

export function parseMangaRef(input: string): ParsedMangaRef {
  let s = (input || '').trim();
  if (!s) throw new Error('Empty manga identifier');

  // Full URL -> pathname
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      throw new Error(`Invalid manga URL: ${input}`);
    }
  }

  // Strip leading/trailing slashes and the route prefix
  s = s.replace(/^\/+|\/+$/g, '').replace(/^(title|manga)\//i, '');

  // Legacy format: {slug}.{id}
  const legacy = s.match(/^(.+)\.([a-z0-9]+)$/i);
  if (legacy) {
    const [, slug, id] = legacy;
    return { id, slug, pagePath: `/title/${id}-${slug}` };
  }

  // Current format: {id}-{slug}
  const dash = s.indexOf('-');
  if (dash > 0) {
    const id = s.slice(0, dash);
    const slug = s.slice(dash + 1) || null;
    return { id, slug, pagePath: slug ? `/title/${id}-${slug}` : `/title/${id}` };
  }

  // Bare id
  return { id: s, slug: null, pagePath: `/title/${s}` };
}

/**
 * Normalizes an href found in MangaFire HTML (either URL format) into the
 * current "id-slug" identifier form, so API consumers always get a value
 * they can pass straight back into /api/manga/:id.
 */
export function hrefToMangaId(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const ref = parseMangaRef(href);
    return ref.slug ? `${ref.id}-${ref.slug}` : ref.id;
  } catch {
    return null;
  }
}
