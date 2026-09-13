-- 001 · 基础 schema
--
-- 用 CREATE TABLE IF NOT EXISTS，因此同时覆盖两种起点：
--   全新库（本地首次运行、Serverless 的 /tmp 每次冷启动）→ 建表
--   老库（已存在的 data/app.sqlite）→ 什么都不做，交给 002 重建
--
-- 在此之前建表逻辑写在 store.mjs 的构造函数里，与迁移职责重叠；
-- 现在 schema 只有一个来源，就是本目录。

CREATE TABLE IF NOT EXISTS projects (
  id      TEXT PRIMARY KEY,
  owner   TEXT NOT NULL,
  updated TEXT NOT NULL,
  data    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
  id      TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  owner   TEXT NOT NULL,
  key     TEXT NOT NULL,
  data    TEXT NOT NULL,
  UNIQUE (project, key)
);
