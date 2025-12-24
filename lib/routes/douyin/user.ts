import { config } from '@/config';
import InvalidParameterError from '@/errors/types/invalid-parameter';
import { generate_a_bogus } from '@/routes/toutiao/a-bogus';
import type { Route } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import puppeteer from '@/utils/puppeteer';
import { setCookies } from '@/utils/puppeteer-utils';
import { fallback, queryToBoolean } from '@/utils/readable-social';
import { art } from '@/utils/render';

import type { PostData } from './types';
import { getOriginAvatar, proxyVideo, resolveUrl, templates } from './utils';

export const route: Route = {
    path: '/user/:uid/:routeParams?',
    categories: ['social-media'],
    example: '/douyin/user/MS4wLjABAAAARcAHmmF9mAG3JEixq_CdP72APhBlGlLVbN-1eBcPqao',
    parameters: { uid: 'uid，可在用户页面 URL 中找到', routeParams: '额外参数，query string 格式，请参阅上面的表格' },
    features: {
        requireConfig: false,
        requirePuppeteer: true,
        antiCrawler: true,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['douyin.com/user/:uid'],
            target: '/user/:uid',
        },
    ],
    name: '博主',
    maintainers: ['Max-Tortoise', 'Rongronggg9'],
    handler,
};

async function handler(ctx) {
    const uid = ctx.req.param('uid');
    if (!uid.startsWith('MS4wLjABAAAA')) {
        throw new InvalidParameterError('Invalid UID. UID should start with <b>MS4wLjABAAAA</b>.');
    }
    const headerCookie = ctx.req.header('DOUYIN-COOKIES');
    const cookie = headerCookie || config.douyin.cookies;
    const cookieSource = headerCookie ? 'header' : config.douyin.cookies ? 'env' : 'none';
    logger.info(`Douyin cookie source=${cookieSource}, length=${cookie?.length ?? 0}, prefix=${cookie ? cookie.slice(0, 32) : 'none'}`);
    const routeParams = Object.fromEntries(new URLSearchParams(ctx.req.param('routeParams')));
    const embed = fallback(undefined, queryToBoolean(routeParams.embed), false); // embed video
    const iframe = fallback(undefined, queryToBoolean(routeParams.iframe), false); // embed video in iframe
    const relay = resolveUrl(routeParams.relay, true, true); // embed video behind a reverse proxy

    const pageUrl = `https://www.douyin.com/user/${uid}`;

    const pageData = (await cache.tryGet(
        `douyin:user:${uid}`,
        async () => {
            let postData;
            const browser = await puppeteer();
            const page = await browser.newPage();
            await page.setRequestInterception(true);
            if (cookie) {
                try {
                    await setCookies(page, cookie, '.douyin.com');
                } catch (error) {
                    logger.warn(`Failed to set douyin cookies in puppeteer: ${error}`);
                }
            }

            page.on('request', (request) => {
                request.resourceType() === 'document' || request.resourceType() === 'script' || request.resourceType() === 'xhr' ? request.continue() : request.abort();
            });
            page.on('response', async (response) => {
                const request = response.request();
                if (request.url().includes('/web/aweme/post') && !postData) {
                    try {
                        postData = await response.json();
                    } catch (error) {
                        logger.warn(`Failed to parse /web/aweme/post response: ${error}`);
                    }
                }
            });

            logger.http(`Requesting ${pageUrl}`);
            const mainResponse = await page.goto(pageUrl, {
                waitUntil: 'networkidle2',
            });
            try {
                await page.waitForResponse((response) => response.url().includes('/web/aweme/post'), { timeout: 10000 });
            } catch (error) {
                logger.warn(`Waiting for /web/aweme/post timed out: ${error}`);
            }

            let renderDataText: string | null = null;
            let htmlFromResponse: string | null = null;
            if (mainResponse) {
                try {
                    htmlFromResponse = await mainResponse.text();
                } catch (error) {
                    logger.warn(`Failed to read douyin page response: ${error}`);
                    htmlFromResponse = null;
                }
            }
            if (htmlFromResponse) {
                const match = htmlFromResponse.match(/id="RENDER_DATA"[^>]*>([^<]*)<\/script>/);
                renderDataText = match?.[1] ?? null;
            }
            if (!renderDataText) {
                try {
                    await page.waitForSelector('#RENDER_DATA', { timeout: 10000 });
                    renderDataText = await page.evaluate(() => document.querySelector('#RENDER_DATA')?.textContent ?? null);
                } catch {
                    renderDataText = null;
                }
            }

            await browser.close();

            if (!postData && renderDataText) {
                try {
                    const renderData = JSON.parse(decodeURIComponent(renderDataText));
                    const renderPostData = extractPostDataFromRenderData(renderData);
                    if (renderPostData?.aweme_list?.length) {
                        postData = renderPostData;
                        logger.warn('Falling back to render data for douyin user posts.');
                    }
                } catch (error) {
                    logger.warn(`Failed to parse RENDER_DATA: ${error}`);
                }
            }

            if (!postData) {
                try {
                    const apiParams = new URLSearchParams({
                        device_platform: 'webapp',
                        aid: '6383',
                        channel: 'channel_pc_web',
                        sec_user_id: uid,
                        max_cursor: '0',
                        count: '18',
                        publish_video_strategy_type: '2',
                    });
                    apiParams.set('a_bogus', generate_a_bogus(apiParams.toString(), config.ua));
                    const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/post/?${apiParams.toString()}`;
                    const { data } = await got(apiUrl, {
                        headers: {
                            Referer: pageUrl,
                            'User-Agent': config.ua,
                            ...(cookie ? { Cookie: cookie } : {}),
                        },
                    });
                    if (data?.aweme_list?.length) {
                        postData = data;
                        logger.warn('Falling back to web api for douyin user posts.');
                    }
                } catch (error) {
                    logger.warn(`Failed to fetch douyin web api: ${error}`);
                }
            }

            if (!postData) {
                throw new Error('Empty post data. The request may be filtered by WAF.');
            }

            return postData;
        },
        config.cache.routeExpire,
        false
    )) as PostData;

    if (!pageData.aweme_list?.length) {
        throw new Error('Empty post data. The request may be filtered by WAF.');
    }
    const userInfo = pageData.aweme_list[0].author;
    const userNickName = userInfo.nickname;
    // const userDescription = userInfo.desc;
    const userAvatar = getOriginAvatar(userInfo.avatar_thumb.url_list.at(-1));

    const items = pageData.aweme_list.map((post) => {
        // parse video
        let videoList = post.video?.bit_rate?.map((item) => resolveUrl(item.play_addr.url_list.at(-1)));
        if (relay) {
            videoList = videoList.map((item) => proxyVideo(item, relay));
        }
        let duration = post.video?.duration;
        duration = duration && duration / 1000;
        let img;
        // if (!embed) {
        //     img = post.video && post.video.dynamicCover; // dynamic cover (webp)
        // }
        img =
            img ||
            post.video?.cover?.url_list.at(-1) || // HD
            post.video?.origin_cover?.url_list.at(-1); // LD
        img = img && resolveUrl(img);

        // render description
        const desc = post.desc?.replaceAll('\n', '<br>');
        let media = art(embed && videoList ? templates.embed : templates.cover, { img, videoList, duration });
        media = embed && videoList && iframe ? art(templates.iframe, { content: media }) : media; // warp in iframe
        const description = art(templates.desc, { desc, media });

        return {
            title: post.desc.split('\n')[0],
            description,
            link: `https://www.douyin.com/video/${post.aweme_id}`,
            pubDate: parseDate(post.create_time * 1000),
            category: post.video_tag.map((t) => t.tag_name),
        };
    });

    return {
        title: userNickName,
        // description: userDescription,
        image: userAvatar,
        link: pageUrl,
        item: items,
    };
}

const extractPostDataFromRenderData = (renderData: unknown): PostData | undefined => {
    if (!renderData || typeof renderData !== 'object') {
        return undefined;
    }

    const stack: unknown[] = [renderData];
    const visited = new Set<unknown>();
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current || typeof current !== 'object' || visited.has(current)) {
            continue;
        }
        visited.add(current);

        const candidate = current as Record<string, unknown>;
        if (Array.isArray(candidate.aweme_list)) {
            return candidate as PostData;
        }
        if (Array.isArray(candidate.awemeList)) {
            return { ...candidate, aweme_list: candidate.awemeList } as PostData;
        }

        for (const value of Object.values(candidate)) {
            if (Array.isArray(value)) {
                const first = value[0];
                if (first && typeof first === 'object' && 'aweme_id' in first) {
                    return { aweme_list: value as PostData['aweme_list'] } as PostData;
                }
            } else if (value && typeof value === 'object') {
                stack.push(value);
            }
        }
    }

    return undefined;
};
