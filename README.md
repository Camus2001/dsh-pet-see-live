# dsh-pet-see-live

让你的 dsh-pet **实时看见屏幕并点评**——而不是每隔几分钟一张静止截图。

复用 [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) 的采集与拼图管线（逐帧打分、只在画面变化时出图、多帧拼一张省 token），把拼好的图交给 pet 的 `/chat`，pet 就会用气泡 + 语音点评你正在做的事。

## 安装

前置：桌面版 DSH，且已装 `dsh-pet` 与 `dsh-see-now`（本插件依赖它们）。

```bash
dsh plugin --profile desktop add dsh-pet-see-live
```

装完**重启 DSH** 生效。就这样，没有配置文件要填。

> 源码安装：`git clone` 后运行 `node scripts/install-dev.mjs`，同样重启 DSH。

## 行为

- **随 DSH 启动/关闭**：插件加载即工作，DSH 关闭时自动清理所有采集进程。
- **pet 关闭就停**：检测到 pet 的 HTTP 服务不可用时自动停止抓屏；pet 再开自动恢复。
- **画面变了才看**：静止屏幕几乎不出图；切窗口、滚动、换场景才出图点评。
- **速率保护**：默认最少 45 秒喂一张，串行发送 + 429 指数退避，不会刷屏。

## 调节（可选）

全部通过环境变量，无需改代码：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PET_SEE_MIN_GAP_MS` | `45000` | 两次点评最小间隔（毫秒） |
| `PET_SEE_POST_TIMEOUT_MS` | `120000` | 单次请求超时 |
| `PET_SEE_PROMPT` | `看一眼我现在的屏幕，用简短一句话吐槽或评价，不超过20字。` | 喂图时给 pet 的指令 |

## 日志

`~/.dsh/dsh-pet/see-live-plugin.log`（插件运行日志）与 `screen-watch.log`（每次喂图结果）。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-pet-see-live
```

## 许可

Apache-2.0。屏幕采集与拼图能力来自 [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)（Apache-2.0），版权归其作者所有。
