import { config } from '@/config';
import type { APIRoute } from '@/types';
import logger from '@/utils/logger';

import { checkCookie } from './util';

export const apiRoute: APIRoute = {
    path: '/check-cookie',
    description: '检查小红书 cookie 是否有效',
    maintainers: ['DIYgod'],
    handler,
};

async function handler(ctx) {
    const headerCookie = ctx.req.header('XIAOHONGSHU_COOKIE') || ctx.req.header('XIAOHONGSHU-COOKIE');
    const cookie = headerCookie || config.xiaohongshu.cookie;
    logger.info(`xiaohongshu/check-cookie header cookie length=${headerCookie?.length ?? 0}, prefix=${headerCookie ? headerCookie.slice(0, 32) : 'none'}`);
    const valid = await checkCookie(cookie);
    return {
        code: valid ? 0 : -1,
    };
}
