# Mimi macOS 语音交互调研报告

日期：2026-07-15
状态：已审核

## 调研范围

- 目标：让 Mimi 能被“Mimi/Mimi”语音唤醒、接收命令、朗读结果并转写已有音频。
- 涉及现有模块：Connector Action Bridge、Daemon Event、Attention、macOS 系统通知与原生 Connector。
- 本机能力：Speech Framework、AVFoundation/AVAudioEngine、`/usr/bin/say`、Swift 6。

## 核心发现

### 现状分析

MimiAgent 已能从 CLI、IM、文件、邮件、浏览器和屏幕接收信息，但没有免键盘的 owner 输入。系统通知只能推送，Desktop Connector 的键盘动作也不能替代语音入口。

### 关键流程

Speech Framework 提供音频文件和流式 buffer recognition；AVAudioEngine 能持续向 recognition request 追加麦克风 PCM；`say` 能通过 argv 朗读文本和列出本机声音。Connector 可把唤醒短语之后的正文转换为普通高优先级 command Event，继续复用相同 Attention、Session、Runtime 和 Outbox。

### 现有约束

- 麦克风监听必须显式配置或通过 action 启动，默认关闭。
- 只有以配置的唤醒短语开头的识别结果才进入 Daemon，其他语音不输出 Event。
- 每次识别有时间分段、文本上限和短期重复抑制；不保存原始麦克风音频。
- `say` 朗读时暂停 listener，避免 Mimi 自己的声音再次触发命令。
- 所有文本、路径和参数使用 argv，不经过 Shell；转写正文仍标记为外部数据。

### 风险与问题

- 首次使用需要 Speech Recognition 和 Microphone 系统权限，LaunchAgent 与 Terminal 可能需要分别授权。
- 部分 locale 的识别可能需要网络；`onDevice:true` 会要求本机支持对应语言模型。
- 固定分段会在边界处丢失极短音频或拆分长句，因此唤醒命令应保持简短；这比引入常驻云端音频流更符合轻量边界。

## 与任务相关的关键结论

使用一个 Node Connector 编排一份窄职责 Swift helper 和系统 `say`，即可提供持续唤醒、文件转写与语音输出。语音结果进入现有 Event 流，不增加对话服务器、音频数据库、实时模型连接或第二套工作流。
