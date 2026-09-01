import createHttpError from 'http-errors';
import { client } from '../utils/axiosClient';
import { parseMangaRef } from '../utils/normalize';
import { AxiosError } from 'axios';
import { load } from 'cheerio';
import { MangaChapter, Chapter, Volume, Language } from '../types/parsers/index';

export async function getLanguages(mangaId: string): Promise<Language[]> {
  try {
    const content = await client.get(parseMangaRef(mangaId).pagePath);
    const $ = load(content.data);
    const languages: Language[] = [];
    $('div[data-name="chapter"] .dropdown-menu a').each((_, el) => {
      const item = $(el);
      const text = item.text().trim();
      const m = text.match(/(\d+)\s*Chapters?/i);
      languages.push({
        id: item.attr('data-code') || null,
        title: item.attr('data-title') || null,
        chapters: m ? `${m[1]} Chapters` : null,
        logo: null,
      });
    });
    return languages;
  } catch (err: any) {
    if (err instanceof AxiosError) throw createHttpError(err?.response?.status || 500, err?.response?.statusText || 'Something went wrong');
    if (err?.status) throw err;
    throw createHttpError(500, err?.message);
  }
}

export async function getChapters(mangaId: string, language?: string): Promise<Chapter[] | Language[]> {
  if (!language) return getLanguages(mangaId);
  try {
    // Works with bare ids ("lx8vq"), current slugs ("lx8vq-reborn-..."),
    // legacy slugs ("reborn-....lx8vq") and full URLs.
    const { id } = parseMangaRef(mangaId);
    const response = await client.get(`/ajax/read/${id}/chapter/${language.toLowerCase()}`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    const json = (response.data || {}) as { result?: { html?: string } };
    const html = json?.result?.html ?? '';
    if (!html) {
      throw createHttpError(
        503,
        'MangaFire returned no chapter list — the upstream request was likely blocked. Set SCRAPER_API_KEY in your Worker secrets.'
      );
    }
    const $ = load(html);
    const chapters: Chapter[] = [];
    $('li').each((_, li) => {
      const a = $(li).find('a');
      chapters.push({
        number: a.attr('data-number') ?? '',
        title: a.find('span:first-child').text().trim(),
        chapterId: a.attr('data-id') ?? '',
        language,
        releaseDate: a.find('span:last-child').text().trim() || null,
      });
    });
    return chapters;
  } catch (err: any) {
    if (err instanceof AxiosError) throw createHttpError(err?.response?.status || 500, err?.response?.statusText || 'Something went wrong');
    if (err?.status) throw err;
    throw createHttpError(500, err?.message);
  }
}

export async function getChapterImages(chapterId: string): Promise<string[]> {
  try {
    const response = await client.get(`/ajax/read/chapter/${chapterId}`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    const json = (response.data || {}) as { result?: { images?: string[][] } };
    // Guard every level: when the upstream is Cloudflare-blocked (or the site
    // changes shape), result/images are undefined and a bare `.images` read
    // used to crash the whole route with a 500 TypeError.
    const images = json?.result?.images ?? [];
    if (images.length === 0) {
      throw createHttpError(
        503,
        'MangaFire returned no images for this chapter — the upstream request was likely blocked. Set SCRAPER_API_KEY (ScraperAPI / ScrapingBee / ZenRows) in your Worker secrets.'
      );
    }
    // Each entry is [url, width, height] — return the (token-signed) URLs.
    // These URLs expire; clients should fetch them promptly.
    return images.map(img => img[0]).filter(Boolean);
  } catch (err: any) {
    if (err instanceof AxiosError) throw createHttpError(err?.response?.status || 500, err?.response?.statusText || 'Something went wrong');
    if (err?.status) throw err;
    throw createHttpError(500, err?.message);
  }
}

export async function scrapeChaptersFromInfoPage(mangaSlug: string): Promise<MangaChapter[]> {
  try {
    const content = await client.get(parseMangaRef(mangaSlug).pagePath);
    const $ = load(content.data);
    const chapters: MangaChapter[] = [];
    $('ul.scroll-sm li.item').each((_, el) => {
      chapters.push({
        url: $(el).find('a').attr('href') || null,
        title: $(el).find('a').attr('title') || null,
        chapter: $(el).find('a > span:first-child').text().trim() || null,
        releaseDate: $(el).find('a > span:last-child').text().trim() || null,
      });
    });
    return chapters;
  } catch (err: any) {
    if (err instanceof AxiosError) throw createHttpError(err?.response?.status || 500, err?.response?.statusText || 'Something went wrong');
    if (err?.status) throw err;
    throw createHttpError(500, err?.message);
  }
}

export async function getVolumes(mangaId: string, language: string = 'en'): Promise<Volume[]> {
  try {
    const { id: actualId } = parseMangaRef(mangaId);
    const response = await client.get(`/ajax/manga/${actualId}/volume/${language.toLowerCase()}`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    const json = (response.data || {}) as { result?: string };
    const html = typeof json?.result === 'string' ? json.result : '';
    if (!html) {
      throw createHttpError(
        503,
        'MangaFire returned no volume list — the upstream request was likely blocked. Set SCRAPER_API_KEY in your Worker secrets.'
      );
    }
    const $ = load(html);
    const volumes: Volume[] = [];
    $('.unit').each((_, el) => {
      const img = $(el).find('img').attr('src');
      volumes.push({
        id: $(el).find('a').attr('href') || null,
        image: img?.startsWith('http') ? img : `https://mangafire.to${img}`,
      });
    });
    return volumes;
  } catch (err: any) {
    if (err instanceof AxiosError) throw createHttpError(err?.response?.status || 500, err?.response?.statusText || 'Something went wrong');
    if (err?.status) throw err;
    throw createHttpError(500, err?.message);
  }
}
