import { config } from '@/config';
import type { Route } from '@/types';
import { ViewType } from '@/types';
import logger from '@/utils/logger';

import api from './api';
import mobileApi from './api/mobile-api/api';
import webApi from './api/web-api/api';
import utils from './utils';

const decodeBase64Value = (value?: string) => {
    if (!value) {
        return;
    }
    try {
        return Buffer.from(value, 'base64').toString('utf8');
    } catch {
        return;
    }
};

const getBase64ParamFromUrl = (reqUrl: string, key: string) => {
    const search = new URL(reqUrl, 'http://localhost').search;
    const match = search.match(new RegExp(`[?&]${key}=([^&]*)`));
    if (!match) {
        return;
    }
    const raw = match[1].replaceAll('+', ' ');
    let encoded = raw;
    try {
        encoded = decodeURIComponent(raw);
    } catch {
        // keep raw
    }
    return decodeBase64Value(encoded);
};

export const route: Route = {
    path: '/user/:id/:routeParams?',
    categories: ['social-media'],
    view: ViewType.SocialMedia,
    example: '/twitter/user/_RSSHub',
    parameters: {
        id: 'username; in particular, if starts with `+`, it will be recognized as a [unique ID](https://github.com/DIYgod/RSSHub/issues/12221), e.g. `+44196397`',
        routeParams: 'extra parameters, see the table above',
    },
    features: {
        requireConfig: [
            {
                name: 'TWITTER_USERNAME',
                description: 'Please see above for details.',
            },
            {
                name: 'TWITTER_PASSWORD',
                description: 'Please see above for details.',
            },
            {
                name: 'TWITTER_AUTHENTICATION_SECRET',
                description: 'TOTP 2FA secret, please see above for details.',
                optional: true,
            },
            {
                name: 'TWITTER_AUTH_TOKEN',
                description: 'Please see above for details.',
            },
            {
                name: 'TWITTER_THIRD_PARTY_API',
                description: 'Use third-party API to query twitter data',
                optional: true,
            },
        ],
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    name: 'User timeline',
    maintainers: ['DIYgod', 'yindaheng98', 'Rongronggg9', 'CaoMeiYouRen', 'pseudoyu'],
    handler,
    radar: [
        {
            source: ['x.com/:id'],
            target: '/user/:id',
        },
    ],
};

async function handler(ctx) {
    const usernameFromQuery = getBase64ParamFromUrl(ctx.req.url, 'TWITTER_USERNAME_b64') ?? decodeBase64Value(ctx.req.query('TWITTER_USERNAME_b64'));
    const passwordFromQuery = getBase64ParamFromUrl(ctx.req.url, 'TWITTER_PASSWORD_b64') ?? decodeBase64Value(ctx.req.query('TWITTER_PASSWORD_b64'));
    const authTokenFromQuery = getBase64ParamFromUrl(ctx.req.url, 'TWITTER_AUTH_TOKEN_b64') ?? decodeBase64Value(ctx.req.query('TWITTER_AUTH_TOKEN_b64'));

    if (usernameFromQuery || passwordFromQuery || authTokenFromQuery) {
        if (usernameFromQuery) {
            config.twitter.username = [usernameFromQuery];
        }
        if (passwordFromQuery) {
            config.twitter.password = [passwordFromQuery];
        }
        if (authTokenFromQuery) {
            config.twitter.authToken = [authTokenFromQuery];
        }
        logger.info(`twitter/user decoded query values: username=${usernameFromQuery ?? 'none'}, password=${passwordFromQuery ?? 'none'}, authToken=${authTokenFromQuery ?? 'none'}`);
    }

    const id = ctx.req.param('id');

    // For compatibility
    const { count, include_replies, include_rts } = utils.parseRouteParams(ctx.req.param('routeParams'));
    const params = count ? { count } : {};

    const activeApi = config.twitter.thirdPartyApi || config.twitter.authToken?.length ? webApi : config.twitter.username?.length && config.twitter.password?.length ? mobileApi : api;
    await activeApi.init();
    const userInfo = await activeApi.getUser(id);
    let data;
    try {
        data = await (include_replies ? activeApi.getUserTweetsAndReplies(id, params) : activeApi.getUserTweets(id, params));
        if (!include_rts) {
            data = utils.excludeRetweet(data);
        }
    } catch (error) {
        logger.error(error);
    }

    const profileImageUrl = userInfo?.profile_image_url || userInfo?.profile_image_url_https;

    return {
        title: `Twitter @${userInfo?.name}`,
        link: `https://x.com/${userInfo?.screen_name}`,
        image: profileImageUrl.replace(/_normal.jpg$/, '.jpg'),
        description: userInfo?.description,
        item:
            data &&
            utils.ProcessFeed(ctx, {
                data,
            }),
        allowEmpty: true,
    };
}
