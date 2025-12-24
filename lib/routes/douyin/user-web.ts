import { config } from '@/config';
import InvalidParameterError from '@/errors/types/invalid-parameter';
import { generate_a_bogus } from '@/routes/toutiao/a-bogus';
import type { Route } from '@/types';
import cache from '@/utils/cache';
import got from '@/utils/got';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import { fallback, queryToBoolean } from '@/utils/readable-social';
import { art } from '@/utils/render';

import type { PostData } from './types';
import { getOriginAvatar, proxyVideo, resolveUrl, templates } from './utils';

export const route: Route = {
    path: '/user-web/:uid/:routeParams?',
    categories: ['social-media'],
    example: '/douyin/user-web/MS4wLjABAAAARcAHmmF9mAG3JEixq_CdP72APhBlGlLVbN-1eBcPqao',
    parameters: {
        uid: 'User sec uid starting with MS4wLjABAAAA',
        routeParams: 'Additional query string parameters',
    },
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: true,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['douyin.com/user/:uid'],
            target: '/user-web/:uid',
        },
    ],
    name: 'User posts (web api)',
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
        `douyin:user-web:${uid}`,
        async () => {
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
            const response = await got(apiUrl, {
                headers: {
                    Referer: pageUrl,
                    'User-Agent': config.ua,
                    ...(cookie ? { Cookie: cookie } : {}),
                },
            });
            const { data } = response;
            if (!data?.aweme_list?.length) {
                const status = response.statusCode;
                const bodyPreview = JSON.stringify(data ?? {}).slice(0, 500);
                logger.warn(`Douyin web api empty. status=${status} body=${bodyPreview}`);
                throw new Error('Empty post data. The request may be filtered by WAF.');
            }
            return data;
        },
        config.cache.routeExpire,
        false
    )) as PostData;

    const userInfo = pageData.aweme_list[0].author;
    const userNickName = userInfo.nickname;
    const userAvatar = getOriginAvatar(userInfo.avatar_thumb.url_list.at(-1));

    const items = pageData.aweme_list.map((post) => {
        let videoList = post.video?.bit_rate?.map((item) => resolveUrl(item.play_addr.url_list.at(-1)));
        if (relay) {
            videoList = videoList.map((item) => proxyVideo(item, relay));
        }
        let duration = post.video?.duration;
        duration = duration && duration / 1000;
        let img =
            post.video?.cover?.url_list.at(-1) || post.video?.origin_cover?.url_list.at(-1); // HD // LD
        img = img && resolveUrl(img);

        const desc = post.desc?.replaceAll('\n', '<br>');
        let media = art(embed && videoList ? templates.embed : templates.cover, { img, videoList, duration });
        media = embed && videoList && iframe ? art(templates.iframe, { content: media }) : media;
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
        image: userAvatar,
        link: pageUrl,
        item: items,
    };
}
