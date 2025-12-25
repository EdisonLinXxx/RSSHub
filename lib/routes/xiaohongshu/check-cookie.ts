import { config } from '@/config';
import type { APIRoute } from '@/types';
import logger from '@/utils/logger';

import { checkCookie } from './util';

const getCookieFromUrlBase64 = (reqUrl: string) => {
    const search = new URL(reqUrl, 'http://localhost').search;
    const match = search.match(/[?&]vokecookie_b64=([^&]*)/);
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
    try {
        return Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
        return;
    }
};

export const apiRoute: APIRoute = {
    path: '/check-cookie',
    description: '检查小红书 cookie 是否有效',
    maintainers: ['DIYgod'],
    handler,
};

async function handler(ctx) {
    const headerCookie = ctx.req.header('XIAOHONGSHU_COOKIE') || ctx.req.header('XIAOHONGSHU-COOKIE');
    const cookieFromQuery = getCookieFromUrlBase64(ctx.req.url) ?? ctx.req.query('vokecookie_b64');
    const cookie = cookieFromQuery || headerCookie || config.xiaohongshu.cookie;
    const cookieSource = cookieFromQuery ? 'query' : headerCookie ? 'header' : config.xiaohongshu.cookie ? 'config' : 'none';
    const cookiePrefix = cookie ? cookie.slice(0, 32) : 'none';
    logger.info(`xiaohongshu/check-cookie cookie source=${cookieSource}, length=${cookie?.length ?? 0}, prefix=${cookiePrefix}`);
    const valid = await checkCookie(cookie);
    return {
        code: valid ? 0 : -1,
    };
}
