import { load } from 'cheerio';

import { config } from '@/config';
import type { Route } from '@/types';
import { ViewType } from '@/types';
import got from '@/utils/got';
import logger from '@/utils/logger';
import { parseDate, parseRelativeDate } from '@/utils/parse-date';
import { getPuppeteerPage } from '@/utils/puppeteer';

const rootUrl = 'https://cn.investing.com';
const newsUrl = `${rootUrl}/news/most-popular-news`;
const isChallengePage = (content: string) => /Just a moment\.\.\.|cf_chl_opt|challenge-platform/i.test(content);
const fetchWithRealBrowser = async (url: string, selector: string) => {
    if (!config.puppeteerRealBrowserService) {
        return '';
    }
    try {
        const response = await fetch(`${config.puppeteerRealBrowserService}?url=${encodeURIComponent(url)}&selector=${encodeURIComponent(selector)}`);
        const json = await response.json();
        return (json.data?.at(0) || '') as string;
    } catch {
        return '';
    }
};
const cookieDomain = new URL(rootUrl).hostname;
const cookieKeysToSkip = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite', 'priority']);
const parseCookieHeader = (cookieHeader: string) =>
    cookieHeader
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            const index = part.indexOf('=');
            if (index <= 0) {
                return null;
            }
            const name = part.slice(0, index).trim();
            if (!name || cookieKeysToSkip.has(name.toLowerCase())) {
                return null;
            }
            return {
                name,
                value: part.slice(index + 1),
                domain: cookieDomain,
            };
        })
        .filter(Boolean);

export const route: Route = {
    path: '/most-popular-news',
    categories: ['finance'],
    view: ViewType.Articles,
    example: '/investing/most-popular-news',
    parameters: {
        limit: {
            description: '限制条数，默认 20',
            default: '20',
        },
        cookie: {
            description: '可选，传入 `__cf_bm` 等 Cookie 字符串用于抓取正文',
        },
        puppeteer: {
            description: '是否启用 Puppeteer 抓取正文，默认 false；在 Cloudflare 拦截时使用',
            default: 'false',
        },
    },
    features: {
        requireConfig: false,
        requirePuppeteer: true,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['cn.investing.com/news/most-popular-news'],
            target: '/investing/most-popular-news',
        },
    ],
    name: '最热资讯',
    maintainers: ['542895045@qq.com'],
    handler,
    description: '抓取 Investing.com 最热门资讯页面，如需正文可在请求中附带 Cloudflare Cookie（如 `__cf_bm`），或启用 puppeteer 兜底。',
};

async function handler(ctx) {
    const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit'), 10) : 20;

    // 合并 query/header/env 的 cookie，避免上游 header 覆盖掉可用的 env cookie
    const cookieParts = [];
    if (ctx.req.query('cookie')) {
        cookieParts.push(ctx.req.query('cookie'));
    }
    if (ctx.req.header('cookie')) {
        cookieParts.push(ctx.req.header('cookie'));
    }
    if (process.env.Investing_Cookie) {
        cookieParts.push(process.env.Investing_Cookie);
    }
    const cookie = cookieParts.join('; ');
    const cookieSource = ctx.req.query('cookie') ? 'query+env/header' : ctx.req.header('cookie') ? 'header+env' : process.env.Investing_Cookie ? 'env' : 'none';
    const usePuppeteer = (ctx.req.query('puppeteer') ?? process.env.Investing_UsePuppeteer ?? 'false').toString().toLowerCase() === 'true';
    logger.info(`investing/most-popular-news cookie source=${cookieSource}, length=${cookie?.length ?? 0}, prefix=${cookie ? cookie.slice(0, 32) : 'none'}, puppeteer=${usePuppeteer}`);

    const fetchListHtml = async () => {
        let listHtml = '';
        try {
            const response = await got.get(newsUrl, {
                headers: {
                    cookie,
                    'user-agent': config.ua,
                },
                retry: 0,
            });
            listHtml = typeof response.data === 'string' ? response.data : response.data.toString('utf-8');
            if (!listHtml || isChallengePage(listHtml)) {
                throw new Error('Blocked by Cloudflare');
            }
            return listHtml;
        } catch (error) {
            if (!usePuppeteer) {
                throw error;
            }
        }

        logger.info('investing/most-popular-news using puppeteer for list page');
        let pageContext: Awaited<ReturnType<typeof getPuppeteerPage>> | undefined;
        try {
            pageContext = await getPuppeteerPage(newsUrl, {
                onBeforeLoad: async (page) => {
                    page.setDefaultNavigationTimeout(60000);
                    page.setDefaultTimeout(60000);
                    if (cookie) {
                        const cookies = parseCookieHeader(cookie);
                        if (cookies.length) {
                            await page.setCookie(...cookies);
                        }
                    }
                },
                gotoConfig: {
                    waitUntil: 'domcontentloaded',
                },
            });
            listHtml = await pageContext.page.content();
        } finally {
            await pageContext?.destory?.();
        }

        if ((!listHtml || isChallengePage(listHtml)) && config.puppeteerRealBrowserService) {
            logger.info('investing/most-popular-news using real-browser service for list page');
            const html = await fetchWithRealBrowser(newsUrl, '.largeTitle, #leftColumn, article');
            if (html) {
                return html;
            }
        }

        return listHtml;
    };

    const listHtml = await fetchListHtml();
    const $ = load(listHtml);

    const listSelector = '.largeTitle article, .largeTitle .articleItem, #leftColumn article, #leftColumn .articleItem, article';
    let listItems = $(listSelector)
        .toArray()
        .map((item) => {
            const $item = $(item);
            const linkEl = $item.find('a.title[href*="/news/"]').first().length > 0 ? $item.find('a.title[href*="/news/"]').first() : $item.find('a[href*="/news/"]').first();
            const rawLink = linkEl.attr('href')?.trim() ?? '';
            if (!rawLink) {
                return null;
            }
            const link = rawLink.startsWith('http') ? rawLink : new URL(rawLink, rootUrl).href;
            const title = linkEl.attr('title')?.trim() || linkEl.text().trim();
            const summary = $item.find('p').first().text().trim();
            const timeEl = $item.find('time').first();
            const datetime = timeEl.attr('datetime')?.trim();
            const timeText = timeEl.text().trim() || $item.find('.date, .dateTime, .articleDate').first().text().trim();
            const pubDateCandidate = datetime ? parseDate(datetime) : timeText ? parseRelativeDate(timeText) : undefined;
            const pubDate = pubDateCandidate instanceof Date && !Number.isNaN(pubDateCandidate.getTime()) ? pubDateCandidate : undefined;

            return {
                title,
                link,
                pubDate,
                description: summary || undefined,
            };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item && item.link && item.title));

    if (listItems.length === 0 && !cookie && !usePuppeteer) {
        throw new Error('Failed to parse list page. Try passing a valid cookie or enabling puppeteer.');
    }

    listItems = listItems.slice(0, limit);
    const items = listItems;

    return {
        title: 'Investing.com 最热资讯',
        link: newsUrl,
        item: items,
    };
}
