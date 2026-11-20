# dsh-pet-see-live

让你的 dsh-pet **实时看见屏幕并点评**——而不是每隔几分钟一张静止截图。

复用 [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) 的采集与拼图管线（逐帧打分、只在画面变化时出图、多帧拼一张省 token），把拼好的图交给 pet 的 `/chat`，pet 就会用气泡 + 语音点评你正在做的事。

## 安装

前置：桌面版 DSH，且已装 `dsh-pet` 与 `dsh-see-now`（本插件依赖它们）。

从 **Releases** 下载源码包（或 `git clone` 本仓库），进入目录后运行：

```bash
node scripts/install-dev.mjs
```

脚本会把插件复制进 desktop profile 并登记 bundle，装完**重启 DSH** 生效。没有配置文件要填。

> 为什么不用 `dsh plugin add`：desktop profile 由 DSH 桌面端独占管理，`dsh plugin --profile desktop ...` 会被拒绝，所以这里用随附的 `install-dev.mjs` 安装（和 see-now 的源码安装方式一致）。
> 想先看看会改什么：`node scripts/install-dev.mjs --check`。可用 `DSH_PROFILE` 指定其它 profile。

## 行为

- **随 DSH 启动/关闭**：插件加载即工作，DSH 关闭时自动清理所有采集进程。
- **pet 关闭就停**：检测到 pet 的 HTTP 服务不可用时自动停止抓屏；pet 再开自动恢复。
- **画面变了才看**：静止屏幕几乎不出图；切窗口、滚动、换场景才出图点评。
- **速率保护**：串行发送 + 429 指数退避，不会刷屏。

## 参数跟随 see-now

本插件只做桥接，本身**没有任何独立配置项**。采集的分辨率、帧率、出图节奏（pace）与间隔，全部取自你已有的 see-now 设置：

- 节奏档位、fps、各种阈值 → `~/.dsh/see-now.json`（see-now 的用户配置），没有则用 see-now 内置默认值
- 分辨率档位、出图参数 → see-now 内置的 `SIZES` / `PACES`

想让 pet 看得更勤或更省，改 see-now 的配置即可，不用动本插件。

## 日志

`~/.dsh/dsh-pet/see-live-plugin.log`（插件运行日志）与 `screen-watch.log`（每次喂图结果）。

## 卸载

在仓库目录运行：

```bash
node scripts/install-dev.mjs --remove
```

然后重启 DSH。

## 许可

Apache-2.0。屏幕采集与拼图能力来自 [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)（Apache-2.0），版权归其作者所有。
