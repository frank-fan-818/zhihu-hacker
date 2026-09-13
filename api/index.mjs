// Vercel 函数入口。整个应用由路由重写集中转发到这里，等价于原来的长驻进程，
// 但状态不再依赖进程内存：OAuth 状态在 Redis，草稿在 /tmp 的 SQLite。
// Node 运行时要求 24，因为 node:sqlite 在该版本可用（见 .nvmrc）。
import { createRequestHandler } from '../src/server.mjs';

const handler = createRequestHandler();

export default handler;
