import createHttpError from 'http-errors';
import { client } from '../utils/axiosClient';
import { parseMangaRef, hrefToMangaId } from '../utils/normalize';
import { AxiosError } from 'axios';
import { load } from 'cheerio';
import { ScrapedManga } from '../types/parsers/index';

async function scrapeMangaInfo(id: string): Promise<ScrapedManga> {
  const res: ScrapedManga = {
    mangaInfo: {
      title: null,
      altTitles: null,
      poster: null,
      status: null,
      type: null,
      description: null,
      author: null,
      published: null,
      genres: [],
      rating: null,
      chapters: [],
    },
    relatedManga: [],
    similarManga: [],
  };
  try {
    // Accepts full URLs, current-format slugs, legacy slugs, or bare ids.
    const content = await client.get(parseMangaRef(id).pagePath);
    const $ = load(content.data);
    res.mangaInfo = {
      title: $('h1[itemprop="name"]').text().trim(),
      altTitles: $('h1[itemprop="name"]').siblings('h6').text().trim(),
      poster: $('.poster img').attr('src')?.trim() || null,
      status: $('.info > p').first().text().trim(),
      type: $('.min-info a').first().text().trim(),
      description: $('.description').text().replace('Read more +', '').trim(),
      author: $('.meta div:contains("Author:") a').text().trim(),
      published: $('.meta div:contains("Published:")').text().replace('Published:', '').trim(),
      genres: $('.meta div:contains("Genres:") a')
        .map((_, e) => $(e).text().trim())
        .get(),
      rating: $('.rating-box .live-score').text().trim(),
      chapters: [],
    };
    $('section.side-manga.default-style div.original.card-sm.body a.unit').each((_, el) => {
      res.similarManga.push({
        id: hrefToMangaId($(el).attr('href')),
        name: $(el).find('.info h6').text().trim() || null,
        poster: $(el).find('.poster img').attr('src')?.trim() || null,
      });
    });
    if (!res.mangaInfo.title) {
      // Parsing succeeded but found nothing: the page was almost certainly a
      // Cloudflare challenge (or the site changed). Surface a clear error
      // instead of a misleading 200 with empty fields.
      throw createHttpError(
        503,
        'MangaFire returned an empty title page — the upstream request was likely blocked by Cloudflare. Set SCRAPER_API_KEY in your Worker secrets.'
      );
    }
    return res;
  } catch (err: any) {
    if (err instanceof AxiosError) throw createHttpError(err?.response?.status || 500, err?.response?.statusText || 'Something went wrong');
    if (err?.status) throw err;
    throw createHttpError(500, err?.message);
  }
}
export default scrapeMangaInfo;
