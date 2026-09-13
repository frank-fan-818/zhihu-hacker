// Vercel 函数入口。OAuth、草稿、任务与预算共享 Redis；
// waitUntil 绑定本次任务生命周期，任务截止时间处理异常中止。
// Node 运行时要求 24，因为 node:sqlite 在该版本可用（见 .nvmrc）。
import { createRequestHandler } from '../src/server.mjs';
import { waitUntil } from '@vercel/functions';

const handler = createRequestHandler({waitUntil});

export default handler;
