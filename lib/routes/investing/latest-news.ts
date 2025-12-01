import { load } from 'cheerio';

import { config } from '@/config';
import type { Route } from '@/types';
import { ViewType } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import { getPuppeteerPage } from '@/utils/puppeteer';
import parser from '@/utils/rss-parser';

const rootUrl = 'https://cn.investing.com';
const feedUrl = `${rootUrl}/rss/news.rss`;

export const route: Route = {
    path: '/latest-news',
    categories: ['finance'],
    view: ViewType.Articles,
    example: '/investing/latest-news',
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
            source: ['cn.investing.com/news/latest-news'],
            target: '/investing/latest-news',
        },
    ],
    name: '最新资讯',
    maintainers: ['542895045@qq.com'],
    handler,
    description: '来源于官方 RSS，如需正文可在请求中附带 Cloudflare Cookie（如 `__cf_bm`），或启用 puppeteer 兜底。',
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
    logger.info(`investing/latest-news cookie source=${cookieSource}, length=${cookie?.length ?? 0}, prefix=${cookie ? cookie.slice(0, 32) : 'none'}, puppeteer=${usePuppeteer}`);

    const feedResponse = await got.get(feedUrl, {
        headers: {
            cookie,
            'user-agent': config.ua,
        },
        retry: 0,
    });
    const feedContent = typeof feedResponse.data === 'string' ? feedResponse.data.trimStart() : feedResponse.data.toString('utf-8').trimStart();
    if (!feedContent.startsWith('<')) {
        throw new Error('RSS feed is not valid XML, maybe blocked by Cloudflare. Try passing a valid cookie.');
    }

    const feed = await parser.parseString(feedContent);

    let items = (feed.items ?? []).slice(0, limit).map((item) => {
        const link = item.link ?? '';
        return {
            title: item.title,
            link: link.startsWith('http') ? link : new URL(link, rootUrl).href,
            author: item.author ?? item.creator,
            pubDate: parseDate(item.isoDate ?? item.pubDate),
        };
    });

    const fetchItem = (item) =>
        cache.tryGet(item.link, async () => {
            const tryGot = async () => {
                if (!cookie) {
                    return false;
                }
                try {
                    const response = await got({
                        method: 'get',
                        url: item.link,
                        headers: {
                            cookie,
                            'user-agent': config.ua,
                        },
                        retry: 0,
                    });

                    const $ = load(response.data);

                    $('script, style, noscript, iframe').remove();

                    const content = $('#articlePage').length ? $('#articlePage') : $('.articlePage');
                    const article = content.length ? content : $('article');

                    const html = article.html() || $('meta[property="og:description"]').attr('content');
                    if (html) {
                        item.description = html;
                        return true;
                    }
                } catch (error) {
                    logger.warn(`investing/latest-news got fetch failed for ${item.link}: ${error}`);
                }
                return false;
            };

            const gotOk = await tryGot();
            if (gotOk || !usePuppeteer) {
                return item;
            }

            logger.info(`investing/latest-news using puppeteer for ${item.link}`);
            let pageContext: Awaited<ReturnType<typeof getPuppeteerPage>> | undefined;
            try {
                pageContext = await getPuppeteerPage(item.link, {
                    gotoConfig: {
                        waitUntil: 'networkidle2',
                    },
                });
                const page = pageContext.page;
                try {
                    await page.waitForSelector('#articlePage, .articlePage, article', { timeout: 15000 });
                } catch {
                    // ignore timeout; still try to read content
                }
                const content = await page.content();
                const $ = load(content);

                $('script, style, noscript, iframe').remove();
                const container = $('#articlePage').length ? $('#articlePage') : $('.articlePage');
                const article = container.length ? container : $('article');

                const html = article.html() || $('meta[property="og:description"]').attr('content');
                if (html) {
                    item.description = html;
                }
            } catch (error) {
                logger.warn(`investing/latest-news puppeteer fetch failed for ${item.link}: ${error}`);
            } finally {
                await pageContext?.destory?.();
            }

            return item;
        });

    if (usePuppeteer) {
        // 避免同时启动过多浏览器，串行处理
        const out: typeof items = [];
        for (const item of items) {
            // eslint-disable-next-line no-await-in-loop -- sequential on purpose to limit puppeteer instances
            out.push(await fetchItem(item));
        }
        items = out;
    } else {
        items = await Promise.all(items.map((item) => fetchItem(item)));
    }

    return {
        title: feed.title ?? 'Investing.com 最新资讯',
        link: `${rootUrl}/news/latest-news`,
        item: items,
    };
}
