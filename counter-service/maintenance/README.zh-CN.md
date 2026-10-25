# 云端检查和每日备份

`rui-chen-counter-maintenance` 是独立的 Cloudflare Worker。它通过数据库绑定读取主计数库，把快照保存到第二个私有 D1 `rui-chen-counter-backups`，运行时不需要 OAuth 令牌、电脑或 Codex。备份库没有公开下载接口。

## 自动运行

- Cloudflare Cron 每 15 分钟执行，经内部 Service Binding 只读检查主 API 的 `/health`、`/v1/stats`，不会新增访问。公开 HTTPS 可达性由 GitHub 另行检查；同账号 `workers.dev` 之间按 Cloudflare 要求使用 Service Binding。
- 每日 UTC 04:45 起的首个成功运行保存当日第一份快照；失败在后续 15 分钟运行时重试。没有任何备份时立即补第一份。柏林冬令时对应 05:45，夏令时对应 06:45。
- 快照保留最近 30 份成功记录，包含 5 张业务表的数据及完整表、索引、触发器定义；每份附 SHA-256。源读取和目标写入分别使用 D1 事务；失败不覆盖旧快照。
- 数据先校验 schema、主键、访客集合与累计值，再分块原子写入。相同日期并发或重试不会混合两份快照。每天不重复全表复制，正常巡检仅做小量查询。
- 免费 Worker 有 CPU 限制。本实现对每表设置 10,000 行及约 2 MiB 的快照上限；超限报告失败并保留旧备份，不能默默写入残缺快照。超过该规模需调整备份方案。

`https://rui-chen-counter-maintenance.cr20010218.workers.dev/health` 只公开检查与备份的时间及 `ok`。最近检查超过 45 分钟、最近备份超过 36 小时，或检查/备份失败时返回 HTTP 503。它也能发现定时任务停止后仍保留的旧成功状态。

GitHub Actions 每小时第 23 分钟从另一平台检查主 API 和维护状态，连续 3 轮失败使工作流失败。邮件需在 GitHub 账号开启 Actions 通知；公开仓库闲置 60 天可能停用 GitHub 定时工作流。Cloudflare 的每 15 分钟巡检和每日备份不受该 GitHub 条件影响。详见 [外部检查说明](../CLOUD-HEALTH.zh-CN.md)。

## 初始化与部署

在已有主库配置及原账号授权的环境执行：

```sh
npm run cloud:setup
npm test
npm run cloud:deploy
npm run cloud:bootstrap
npm run cloud:restore-check
npm run cloud:health
```

`cloud:setup` 校验原账号和数据库 UUID，只对独立备份库应用迁移。`cloud:deploy` 上传维护 Worker 和独立管理密钥；该密钥只允许手动启动一次检查/当日备份，不能读取快照，不放在网页、GitHub 或源码中。`cloud:bootstrap` 用本机私有密钥验证首次实际云端运行，不增加 PV。

`cloud:restore-check` 通过当前 Cloudflare 账号授权下载最新快照，校验完整 SHA-256、分块顺序与 schema，转换成 SQL，再实际恢复到临时 SQLite，验证汇总、访客集合、新访问与重复访问计数。业务数据恢复顺序是表、数据、索引与触发器，避免恢复时重新计数；同时重建已应用的 `0001_counter.sql` 迁移记录。下载文件只写入被 Git 排除的 `private-backups/`。

## 真正恢复时

先恢复到新的测试库并验证，不直接覆盖生产库。确认数据及日期后再更换主 Worker 的数据库绑定，保留原 `VISITOR_SECRET`。恢复到较早计数时为 `site_stats.epoch` 设置新随机值，使前端接受合法的回退。维护 Worker 的 `SOURCE_DB` 绑定也应一并更新并重新验收。

版本 1 快照只支持当前已验证 schema；新迁移需同步更新快照校验和迁移记录恢复逻辑，否则备份会明确失败。快照不包含访客原始 UUID、原始 IP 或 OAuth/Worker Secret；原访客密钥另存于 Cloudflare Secret 和所有者的私有备份。

第二 D1 与主库同属一个 Cloudflare 账号，可应对单库误操作，不能替代账号之外的独立备份。D1 原生 Time Travel 仍自动提供免费方案最近 7 天的时间点恢复。保留现有私有 SQL 备份作为额外副本。

官方依据：[D1 事务 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、[Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)。
