# GitHub 云端外部检查

`.github/workflows/counter-health.yml` 每小时 UTC 第 23 分钟执行，也可从 Actions 页面手动运行；相关源码、维护脚本和工作流推送到 `main` 时执行一次。Ubuntu 24.04 使用 Node.js 24，直接运行 `scripts/cloud-health.mjs`，无需安装 npm 依赖，也不需要 Cloudflare 或通知服务密钥。

脚本仅发送三个公开 GET：主统计 API 的 `/health`、`/v1/stats`，维护 API 的 `/health`。不会提交 `/v1/visits`，不增加浏览量。主服务必须就绪且返回有效 PV/UV 元数据；维护服务必须返回 `ok:true`、距检查时刻不足 45 分钟的 `last_check_at` 和不足 36 小时的 `last_backup_at`。异常未来时间也会失败。每个请求超时 8 秒，总共检查 3 轮，失败轮次之间等待 10 秒；持续失败使工作流失败。

默认地址固定为已配置的两个公开 Worker。仅在本机集成测试需要时使用 `COUNTER_API_BASE`、`COUNTER_MAINTENANCE_API_BASE` 覆盖 HTTPS origin；HTTP 仅允许同时显式设置 `COUNTER_HEALTH_ALLOW_LOCALHOST=true` 的 `localhost`、`127.0.0.1` 或 `::1`。URL 中不能含用户名、密码、查询参数或非根路径；错误日志不回显 URL、原始响应正文或原生网络错误。

此检查验证维护服务报告的最近成功时间；它自身不执行数据库备份，也不能单独证明备份能够恢复。正式恢复校验由备份流程和验收记录负责。

## 调度与通知条件

- 工作流必须发布在默认分支，且 GitHub Actions 处于启用状态。公开仓库连续 60 天没有仓库活动时，GitHub 会自动停用定时工作流，需要重新启用。计划任务可能延迟或被丢弃，因此它不是严格按时的可用性保证。[官方 schedule 说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- 失败退出会产生 failed run；是否收到邮件或网页通知取决于用户的 GitHub Actions 通知设置，可选择仅失败时通知。定时任务的通知接收者与最初创建、后续修改 cron 或重新启用任务的用户有关；需在账号设置中核对，不能仅凭脚本非零退出声称通知已经送达。[官方通知说明](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)
- 本工作流不创建 Issue、不发送自定义邮件，也不保存跨运行的故障去重状态；长期故障可能产生多次 failed run。通知频率由 GitHub 原生偏好管理。

Actions 固定到官方稳定版的完整提交 SHA，核实于 2026-10-25：

- [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0)：`949feb2413d6458794dcd2491c4babbbce0c15c1`。
- [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)：`3d3c42e5aac5ba805825da76410c181273ba90b1`。

本地单元检查：`node --test counter-service/test/cloud-health.test.mjs`。测试通过注入 fetch、时钟和等待函数模拟失败重试，不访问生产服务，也不真的等待重试间隔。
