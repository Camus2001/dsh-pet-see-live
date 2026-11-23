# dsh-pet-see-live

让你的 dsh-pet **实时看见屏幕、听见同期声音并点评**——而不是每隔几分钟一张静止截图。

复用 [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) 的采集与拼图管线（逐帧打分、只在画面变化时出图、多帧拼一张省 token）和它的音频 listener（WASAPI 回环采集 + 分段转写），把拼好的图与同期台词一起交给 pet 的 `/chat`，pet 就会用气泡 + 语音点评你正在做的事。

## 安装

前置：桌面版 DSH，且已装 `dsh-pet` 与 `dsh-see-now`（本插件依赖它们）。

**听音依赖（Windows）**：see-now 的采集脚本需要 `numpy` 与 `pyaudiowpatch`，用 `~/.dsh/see-window.json` 里配置的 Python 解释器安装：

```bash
python -m pip install numpy pyaudiowpatch
```

不装也能用：抓屏和点评照常工作，只是听音关闭。see-now 自己的 `DSH_SEE_AUDIO=0` 环境变量仍可随时强制关掉听音。

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
- **画面变化触发出图 + 低频兜底**：切窗口、滚动、换场景等画面变化会触发出图点评；画面完全静止时也不会一直沉默——管线按 see-now 节奏档位的兜底间隔仍会出图（内置的 `maxWaitSec` 默认 15 秒，floor 兜底随 pace 变化，`calm` 档约 3~30 秒）。这是 see-now 拼图管线的固有行为；pet 链路未启用 see-now 常驻模式的“空闲就停”逻辑，所以静止画面会有低频点评，并非只在画面变化时才出图。
- **图集带时间顺序**：发给 pet 的文本会写明每格的编号、相对时刻和整段跨度，pet 按时间先后看，而不是把拼图当成一张静态图。
- **同期声音一起听**：开启后采集系统正在播放的声音，**用 see-now 的识别设置**转写成台词，按时间窗附到对应图集上，pet 会结合"看到 + 听到"一起点评。
- **DSH 聚焦就暂停**：当 DSH 主窗口处于系统前台时，自动暂停抓屏与听音（并取消在途的点评请求），焦点离开后恢复。桌宠窗口不算聚焦，点它不会暂停。由 DSH 窗口的 focus / blur 事件判定（跨平台，不再起进程探测前台窗口）；DSH 界面没打开时不会暂停。默认开启，可在设置页关掉。
- **图片超限自动转 JPEG**：桌宠对 `attachment` 的 base64 有 900000 字符上限；超过时用 ffmpeg 转成 JPEG 再发，仍放不下就跳过这一张（记 `SKIP` 日志），不会把请求打成失败、也不会误触发退避。
- **速率保护**：串行发送 + 429 指数退避，不会刷屏；`generate-error`（模型侧报错 / 生成取消）照常退避。
- **会话过大自动重置（可选）**：pet 的 `/chat` 走 ACP 时会复用 dsh-ntr 的 `dsh-pet` 长期会话，上下文会越积越大。开启后，插件在每次发图前通过 dsh-ntr 的 `/acp` 读取该会话的 `usage.used`，超过阈值就先关闭并重建会话，避免单次请求涨到几十万 token。CodeBuddy 会把关闭的会话保存在 `~/.codebuddy/projects/<project>/<sessionId>.jsonl` 并在下一次 prompt 重新加载，所以插件会直接删除这份 transcript 来真正清空上下文；新会话第一条点评可能空一次，插件会自动重试。重置会清空 pet 的 ACP 对话上下文（包括你刚和它聊的内容），人设与设置不受影响。dsh-ntr 不在或接口不可用时自动跳过。
- **按宠物区分看图**：设置页按 dsh-pet 的宠物顺序逐只列出；默认全部关闭。API 宠物可多只同时启用；ACP 宠物同一时间只能启用一只，其他 ACP 开关置灰。每只宠物的人设自动读取 dsh-pet 的 `whisperPrompt`（实例 > 条目 > dsh-pet 内置默认），风格/篇幅可单独填写，留空用默认句。
- **手动清空 ACP 会话**：重置阈值旁有“清空 ACP 会话”按钮，随时关闭并删除共享的 `dsh-pet` 会话。ACP 宠物切换时不会自动清空，只提示可能串味，由用户决定是否清空。

## 设置界面

DSH 设置里的 **dsh-pet-see-live** 分区包含：

- **语音识别（听同期声音）**：开 / 关。
- **DSH 聚焦时暂停识别**：开 / 关，默认开。
- **宠物看图说话**：按 dsh-pet 设置页的顺序逐只列出：
  - 人设（只读，来自 dsh-pet 的 `whisperPrompt`）；
  - 风格 / 篇幅（留空使用默认：“自然随意地用短短一句说说你的想法，可以吐槽、夸奖或贬损。”）；
  - 启用看图发图（默认全部关闭；ACP 宠物同一时间只能启用一只，其他 ACP 开关置灰）。
- **pet 会话记忆超限自动重置**：开 / 关，以及阈值（64k / 128k / 200k / 256k / 300k tokens）。
- **清空 ACP 会话**：在阈值旁边，点击后关闭并删除共享的 `dsh-pet` 会话；只影响 ACP，不影响 API 宠物。
- **保存**：一个按钮保存整个分区（宠物开关、风格、听音、暂停、重置阈值）。

配置落在 `~/.dsh/pet-see-live.json`：

```json
{
  "listenEnabled": false,
  "pauseOnFocus": true,
  "sessionResetEnabled": false,
  "sessionResetThreshold": 200000,
  "pets": {
    "main": { "enabled": false, "commentStyle": "" }
  }
}
```

听音 / 聚焦暂停改动需**重启 DSH** 生效（和 see-now 一致）；宠物开关、风格和 ACP 重置设置保存后即时生效。

## 参数跟随 see-now

除设置页里的**语音识别开关**与**聚焦暂停开关**外，其余参数全部取自你已有的 see-now 设置：

- 节奏档位、fps → `~/.dsh/see-now.json`（see-now 的用户配置），没有则用 see-now 内置默认值
- 拼图参数 → `tierStyle`（每帧大小）、`tierMap`、`tierMode`、`tierCurve`、`tierThresholds`、`scoreNormalize`、`maxCrop` 会传给 pipeline，和 see-now 自己的工具路径一致
- 分辨率 → 取自 see-now 内置的 `SIZES`
- 听音细节 → see-now 的 `listen` 对象（`prefer` / `live` / `silence` / `maxSeg` 等），总开关在本插件设置页；**识别走 see-now 自己的 `resolveTranscriber`**（宿主 SenseVoice 或 `~/.dsh/asr.json` 的本地接口），不另做识别配置

与 see-now 一样，设置页改动**重启 DSH 后生效**。仍不适用于 pet 这条链路的：`wakeBatch` / `imageTrigger` / `imageKeep`（see-now 常驻循环的省图逻辑）、`idleStopMin` / `maxAutonomousWakes`。

想让 pet 看得更勤或更省，改 see-now 的配置即可；想改清晰度或开关听音，用本插件设置页。

**关于语音识别**：识别完全沿用 see-now 的设置页，本插件不重复实现。先在 **see-now 设置页**里把识别配好（`prefer` 选宿主 SenseVoice 或本地，本地需在 see-now 设置页填 `~/.dsh/asr.json` 的接口地址/密钥），本插件直接复用同一份配置。若识别没配好，日志里 `listen start` 会给出 `reason`，抓屏点评不受影响。

## 日志

`~/.dsh/dsh-pet/see-live-plugin.log`（插件运行日志，含 `apply:` 的参数快照、`listen start` 与 `[listen]` 采集日志）与 `screen-watch.log`（每次喂图结果）。听音转写失败会记下 see-now 识别后端返回的原因。

## 卸载

在仓库目录运行：

```bash
node scripts/install-dev.mjs --remove
```

然后重启 DSH。

## 许可

Apache-2.0。屏幕采集与拼图能力来自 [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)（Apache-2.0），版权归其作者所有。
