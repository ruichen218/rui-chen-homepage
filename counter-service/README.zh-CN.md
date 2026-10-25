# Rui Chen 主页自建统计

本包提供 GitHub Pages 网页接入、Cloudflare Worker、D1 数据库迁移、测试及部署运维脚本。2026-10-25 已部署到主页所有者的 Cloudflare 账号，公开配置使用自建服务：`https://rui-chen-homepage-counter.cr20010218.workers.dev`。

切换前已核实并一次性导入历史 PV 基数 4（快照时间 2026-10-25T20:39:13.739Z，原统计始于 2026-10-25）。UV 使用新后台独立口径，从 2026-10-25T20:32:19.345Z 起计算；无法读取的更早历史不补造。发布前的云端备份已经实际恢复校验。

主页按用户要求不再显示起算日期，数据库中的起算元数据保持原值。定时检查和每日备份迁到独立 Cloudflare Worker 与备份 D1；外部检查由 GitHub Actions 执行，均不依赖电脑或 Codex 在线。详见 [云端维护](maintenance/README.zh-CN.md) 和 [外部检查](CLOUD-HEALTH.zh-CN.md)。

## 目录

| 路径 | 用途 |
| --- | --- |
| `../index.html` | 保留原主页内容，只调整统计区域及脚本接入 |
| `../assets/counter-config.js` | 公开配置；当前使用 `self-hosted` 和已验证的 API 地址 |
| `../assets/counter.js` | 浏览器身份、离线队列、安全重试、缓存及中英文显示 |
| `src/worker.js` | Cloudflare 实际部署入口，仅导出默认处理器 |
| `src/index.js` | API、校验、HMAC、事务及清理任务 |
| `migrations/0001_counter.sql` | 五张数据表、索引和三个原子计数触发器 |
| `scripts/` | 初始化、部署、切换、历史导入、备份及健康检查 |
| `test/` | 前端、后端、事务与备份恢复测试 |

## 统计规则

- PV：每次真正加载或刷新页面产生一个新 UUID。语言切换、页内导航、论文展开和 BFCache 返回不再计数。
- UV：同一站点浏览器存储中的随机身份，在自建系统统计期内只计一次；服务端只存站点专属 HMAC。清除存储、无痕模式、换浏览器可能再次计入。
- 浏览器持久化被禁用时，仍尽力记录 PV，但发送 `visitor_id:null`，不凭空制造 UV。
- 每日统计按服务器第一次接受记录的 `Europe/Berlin` 日期归类，包含夏令时处理。隔天才补交的离线访问归收到当天；重试不会把已入库记录移动日期。
- 已确认的历史 PV 可单独作为基数。旧服务 UV 与新身份口径不同，不直接相加。

## 本机检查

需要 Node.js 24 或更高版本。

```sh
cd counter-service
npm ci
npm test
npm run check
```

`npm test` 使用真实 SQLite 执行生产迁移和触发器，使用 fake-indexeddb 测试浏览器存储及并发。`npm run check` 仅编译检查，不部署到云端。

## 部署与后续维护步骤

先在自己的浏览器完成注册、登录及 Wrangler 授权。下列步骤会在你登录的账号中创建 Worker 和 D1；不要求把登录信息写入源码。

```sh
cd counter-service
npm ci
npx wrangler login
npm run setup
npm test
npm run check
npm run deploy
```

初始化会绑定具体账号和数据库 UUID，重复执行时保留它们。发现同名但无法核实的数据库、账号不一致或原访客密钥丢失时会停止，避免覆盖原系统。数据库位置提示为西欧。

部署将验证 `/health` 和 `/v1/stats`，通过后写入本地 `deployment.local.json`。此时网页尚未切换。

如要保留当前服务的历史 PV，先留存切换时可核实的只读快照，保证不会把并行测试阶段的两份访问量相加。不要用调用会增加计数的 POST API 来反复“读取历史”。在自建系统尚无访问时执行：

```sh
npm run import-history -- --pv 已核实的整数 --since YYYY-MM-DD --as-of 完整的ISO时间戳
```

命令中的中文和日期是待替换说明，不可原样运行。历史基数只能导入一次，自建 UV 起始时间取新后台配置，独立于旧快照日期。旧服务较早时期无法读取的数据，不会猜测或补造。

然后完成备份并切换本地网页配置：

```sh
npm run backup
npm run activate
```

检查变更，再把 `index.html` 和整个 `assets/` 一起发布到 GitHub Pages。上线后验证首次访问、同浏览器刷新、第二浏览器、手机和断网恢复，再完成切换验收。`activate` 自身不提交 Git，也不推送网页。

## 故障与重试

- 浏览器用 IndexedDB 事务初始化身份和写入队列，避免多标签页产生不同身份或丢失记录。
- 队列最多 100 条，有效期 7 天。后端去重事件保留 30 天，覆盖队列与重试窗口。
- 同一事件的每次重试始终使用原 `event_id`；服务端提交成功后才响应。网络失败最多进行两次自动重试；重新联网或下次访问时再处理剩余队列。
- 后端明确拒绝的坏记录不会阻塞后续正常记录；配置错误停止自动重试；429、503、断网等保留记录。
- 前台只显示服务器确认值。故障时有缓存则显示上次确认时间，没有缓存则显示暂不可用。自建模式不会自动切回另一家统计服务混算。
- 浏览器不再访问、清除数据或队列超限时，未提交访问仍可能丢失。公开接口的来源校验、输入限制和限速也不能保证绝对防刷。

## 备份、监测与恢复

```sh
npm run backup
npm run verify-backup -- private-backups/某份备份.sql
npm run health
```

备份位于不入 Git 的私有目录，附 SHA-256 清单。每次备份会在临时 SQLite 中实际恢复，检查表、三个计数触发器、汇总与访客集合，再验证新访问及重复访问是否正确计数。

健康检查连续三次失败会返回非零退出码，交由调度器发出通知；健康检查只读，不增加访问量。定时备份和外部检查依赖各自调度器，不能把 Worker 的每日清理任务当作备份或故障通知。本机未运行、休眠或登录授权失效时，本机维护任务无法执行；云端计数仍由 Worker 和 D1 独立处理。

上述 `backup`、`health` 命令仍可手动使用。正式定时维护由云端 `maintenance/` 接管，不再依赖本机自动化：每 15 分钟巡检，每日 UTC 04:45 起首个成功运行保存一份备份，保留最近 30 份；GitHub 每小时第 23 分钟另做外部检查。GitHub 邮件取决于账号通知偏好，公开仓库闲置 60 天可能停用该外部工作流；Cloudflare 自身巡检与备份不依赖它。

私有备份应另存到自己控制的位置，避免与数据库只留在同一账号中。`private-secrets/visitor-secret.txt` 和 `wrangler.local.json` 也要私下保留；SQL 备份不包含 Cloudflare Secret，不能替代原访客密钥。

恢复先在独立测试库验证，保留原库；确认后再切换数据库绑定。如果恢复到较早数据或主动修正总量，需为 `site_stats.epoch` 设置新的随机值并重新验证部署，前端才会接受合法的计数回退。不要在原系统上静默生成新访客密钥，否则旧浏览器会被当成新访客。

Cloudflare 原生时间点恢复当前免费方案为 7 天、付费为 30 天；仍建议保留独立 SQL 备份。导出大型数据库可能短暂阻塞数据库请求，应安排在低访问时段。

## API

| 方法与路径 | 行为 |
| --- | --- |
| `POST /v1/visits` | 接受 UUID 访问编号、可空 UUID 浏览器身份、创建时间和固定页面路径；事务提交后返回最新统计 |
| `GET /v1/stats` | 只读 PV、UV、各自起始时间、确认时间和缓存 epoch |
| `GET /health` | 检查数据库表和访客密钥就绪，不计数 |

网页写入只允许 `https://ruichen218.github.io` 来源和 `/rui-chen-homepage/` 页面标识。CORS 不是身份认证，不能阻止主动伪造请求。当前限速为每个 Cloudflare 节点每 IP 约 120 次/分钟；同一网络可能共享 IP。数据库不存原始 IP、User-Agent 或浏览器原始身份，Worker 应用日志默认关闭；云平台自身仍可能处理连接元数据。

## 交付与权限

`.gitignore` 排除本地密钥、配置、数据库状态、备份和依赖。发布源码包时使用明确的文件清单，不能简单把整个工作目录压缩。`private:true` 只防止误发 npm，不能保护压缩包内容。

云端 Worker、D1、访客密钥和每日旧事件清理任务已部署，健康检查、历史 PV 导入和备份恢复验证已通过。后续修改仍须先本机检查，再验证远端，最后发布网页配置。

官方参考：

- https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
- https://developers.cloudflare.com/d1/reference/time-travel/
- https://developers.cloudflare.com/d1/best-practices/import-export-data/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
