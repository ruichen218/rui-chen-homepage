# 系列活动维护

活动页：`seminars/csu-alumni/index.html`。主页与详情页的中英文内容共用 `assets/seminars-data.js`，无需分别修改两份。

新增一期时，在 `window.CSU_SEMINAR_SERIES.events` 中追加一条记录：

- 使用唯一的 `id`（如 `session-02`）和递增 `number`。
- 填写英文报告题目、讲者的中英文姓名与单位、摘要和介绍。
- `startsAt` 和 `endsAt` 使用明确的北京时间偏移，例如 `2026-11-10T15:00:00+08:00`。
- 将公开海报放在 `assets/seminars/csu-alumni/`，填写 `poster.image` 和 `poster.pdf` 的站点根目录相对路径。没有海报时可省略 `poster`。
- 参会方式统一为邮件联系组织者。上传前检查海报及其他公开文件，确保其中没有会议号和密码。

首页自动展示下一场尚未结束的活动；没有未来场次时展示最近一期。详情页按时间将活动分入近期和往期栏目，已打开的页面也会在开始、结束时更新状态。显示时间始终为北京时间（UTC+8）。

语言切换与主页共用 `rui-chen-homepage-language` 偏好，也支持 `?lang=zh`、`?lang=en` 直接分享。每期可使用 `#session-01` 这样的锚点链接。

详情页与主页另有静态英文回退内容，供 JavaScript 不可用时阅读。系列安排有变化时，也应同步更新相应 HTML 回退内容；正常启用 JavaScript 时，两处内容均从同一份活动数据生成。
