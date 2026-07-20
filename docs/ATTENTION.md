# MimiAgent 注意力与主动简报

长期在线不等于每条消息都调用模型。MimiAgent 在可靠 Inbox 和 Agent Runtime 之间增加了一个轻量的注意力层，用确定性规则决定事件是立即处理、直接通知、忽略，还是先放进摘要池。已决定运行的事件再获得 owner 的 Standing Orders，让 Agent 能按长期替身原则直接处理，而不必等待逐次指令。

默认配置位于 `~/.mimi-agent/daemon/assistant.json`，首次启动自动生成，权限为 `0600`。可通过 `MIMI_ASSISTANT_CONFIG` 指向其他文件。修改后执行：

```bash
mimi daemon attention reload
mimi daemon attention
```

owner 也可先调用 `get_mimi_settings` 读取完整快照，再用 `update_mimi_settings` 调整画像、时区、静默时段、预算、阈值、运行超时、历史保留和简报。该工具只替换这些设置，不覆盖例程、人物、规则或替身策略。

临时专注可用 `snooze_mimi` 设置最长 30 天的自动到期免打扰，并用 `get_mimi_snooze` 查询或 `clear_mimi_snooze` 提前结束。期间非紧急自主事件进入摘要且不生成定时简报；owner 当前直接命令和达到 `urgentPriority` 的事件继续处理。

## 默认决策顺序

1. owner 当前直接命令和内部简报立即运行，不受自治预算限制。
2. 临时免打扰期间，低于紧急阈值的自主事件进入摘要池。
3. 第一条匹配的自定义规则生效。
4. ambient 环境信号进入摘要池，不单独唤醒模型。
5. 静默时段内的非紧急外部事件进入摘要池。
6. 达到全局小时、24 小时或单来源小时预算后，事件进入摘要池。
7. 普通 command 立即响应；达到阈值的 alert / webhook 立即判断。
8. 其他低优先级事件进入下一次简报。

注意力规则只决定何时 run / digest / notify / ignore，不承担权限审批。外部事件默认使用最小策略：不可见 Session/Memory、本地文件、持久写入、Shell、MCP 或外部事务。授权来自另一条确定性路径：只有本机 owner 配置的 source policy 同时命中 source/kind/actor/conversation，事件才获得固定 `reply` 或 `work` 档位；旧策略和未填写 `access` 的策略安全默认到 `reply`，多个匹配采用最高的 `work`。`trust` 仍只记录 provenance，Plan 模式继续只读。

## 紧急事件抢占

`quietHours.urgentPriority` 同时是单 Dispatcher 的抢占阈值，默认 95。长期任务运行中，新 Event 必须同时满足以下条件才会让当前任务让路：已经 ready、priority 达到该阈值、严格高于当前 Event，并且用最新 Attention 配置判断为 `run` 或 `notify`。应进入 digest/ignore 的高分环境噪声不会触发抢占。

抢占只发生在模型思考阶段。任何 Function Tool、MCP Tool、Connector action、Outbox delivery 或 SQLite 事务在途时都不会被中断；工具输出后若紧急 Task 仍在队列，下一次检查立即中止模型 Run。原 Task 原子恢复为 queued，并补偿本次抢占消耗的 attempt 预算，关联 Run 记为 interrupted。它之后使用相同 Task ID 和 execution ledger 续跑，因此已经成功记录的相同副作用不会重复执行。

系统仍只有一个 Dispatcher 和一个 MimiAgent。Event 第一次通过策略解析出实际 Session 后，会在持有事件租约时把该 Session 原子绑定到 Event；后续重试、配置热更新和进程重启都不能把同一 Event 切到另一 Session，从而保持 transcript、Goal 和 execution ledger 的幂等边界。同 Session 的排队项在 claim SQL 中直接避开活动 Session，不再靠反复 claim/requeue 制造 SQLite 状态抖动。抢占不会并发运行两个相同 Session，也没有第二条紧急队列；紧急 Event 只是由既有 `priority DESC, received_at ASC` 顺序先执行。相同或更低 priority 不互相抢占，避免同等级事件抖动。

## 无进展回收与优雅停机

`execution.runIdleTimeoutMs` 限制一次 Agent Run 连续没有模型流事件或 Runtime Event 的时间，默认 1200000ms（20 分钟），可配置 60000ms 至 86400000ms。它不是任务总时长：仍在输出、调用工具或记录运行进展的长任务可以继续工作。修改后执行 `daemon attention reload`，下一次 Run 使用新值，`daemon attention` 的 `execution` 字段可核对当前值。

最后一个 Tool 执行期间 watchdog 暂停，输出返回后才重新计时，避免中途切断结果不确定的文件、Shell、MCP 或 Connector 事务。Tool 自身仍使用各自的 timeout/cancel 边界。除此之外，Dispatcher 会规范化并记录工具名、参数和结果；同一调用重复得到同一结果三次时，在工具安全边界终止该 Run，并把它视为不可自动重试的无进展循环。模型无流量超时仍通过现有 AbortSignal 进入普通 retry/dead-letter/最终失败通知流程；Daemon 正常停止会先等待在途 Tool 返回，再中止模型，且不计失败 attempt，Event 立即恢复 queued，Host Run 记为 interrupted。

## 长期历史保留

`maintenance` 控制 SQLite 历史维护，默认启用、保留 90 天、每 24 小时检查一次。Dispatcher 只在既有循环开头比较一次内存时点，到期后调用 Store transaction，不增加维护线程或第二个定时服务。修改后执行 `daemon attention reload`；禁用会立即停止后续清理，重新启用会在下一轮执行。

清理只覆盖 sent/archived Outbox、已归档 Digest、没有剩余引用的 completed/ignored/digested/archived Event 和其非运行 Run、disabled Schedule、过期 briefing checkpoint 及普通 Audit。queued/running/dead-letter Event、pending/sending/dead-letter Outbox、未归档 Digest、运行中 Run、启用 Schedule、被 Schedule 引用的 Conversation authority root 和活状态/失败项 audit 都排除。dead letter 只有经过 owner 显式 `daemon retry` 或 `daemon archive` 才会变化，后台不会自动重放。`historyRetentionDays` 同时定义持久 Event 去重窗口；窗口外的同一外部 ID 若再次被来源回放，可能成为新 Event。Store 只执行 `PRAGMA optimize` 与 passive WAL checkpoint，不自动阻塞式 `VACUUM`。

## 配置示例

```json
{
  "version": 1,
  "owner": {
    "displayName": "Tony",
    "locale": "zh-CN",
    "focus": ["项目风险", "重要日程", "家人消息"],
    "replyRoute": {
      "channel": "connector:daxiang",
      "target": "owner-conversation-id"
    }
  },
  "timezone": "Asia/Shanghai",
  "quietHours": {
    "enabled": true,
    "start": "23:00",
    "end": "07:30",
    "urgentPriority": 95
  },
  "budgets": {
    "maxRunsPerHour": 20,
    "maxRunsPerDay": 100,
    "maxRunsPerSourcePerHour": 10
  },
  "thresholds": {
    "alertPriority": 75,
    "webhookPriority": 80
  },
  "execution": {
    "runIdleTimeoutMs": 1200000
  },
  "maintenance": {
    "enabled": true,
    "historyRetentionDays": 90,
    "intervalHours": 24
  },
  "briefings": {
    "enabled": true,
    "times": ["08:30", "18:00"],
    "maxItems": 100
  },
  "routines": [
    {
      "id": "morning-plan",
      "enabled": true,
      "time": "08:00",
      "prompt": "检查今日日历、提醒、重要消息、天气和任务风险，直接完成可处理事项后汇报",
      "priority": 70,
      "sessionKey": "mimi-routine-morning"
    },
    {
      "id": "workday-close",
      "enabled": true,
      "time": "18:30",
      "weekdays": [1, 2, 3, 4, 5],
      "prompt": "完成工作日收尾，处理待回复事项并安排可靠后续",
      "priority": 65
    }
  ],
  "people": [
    {
      "id": "alice",
      "displayName": "Alice Chen",
      "aliases": [
        { "source": "mail", "actor": "alice@example.com" },
        { "source": "messages", "actor": "+15550001111" },
        { "source": "daxiang", "actor": "alice-work-id" }
      ],
      "context": [
        "负责 APAC 项目，偏好先看结论再看细节",
        "时间承诺前检查双方日历"
      ]
    }
  ],
  "decisionPolicy": {
    "standingOrders": [
      "能安全且可逆地直接完成的事项就代我完成，处理后简要汇报",
      "涉及时间承诺时检查日历冲突，必要时建立后续提醒"
    ],
    "sourcePolicies": [
      {
        "id": "boss-mail",
        "source": "mail",
        "kinds": ["command", "alert"],
        "actor": "boss@example.com",
        "access": "work",
        "instructions": ["先判断是否影响当天交付；能直接处理就处理，否则立即通知我"]
      },
      {
        "id": "family-chat",
        "source": "messages",
        "conversation": "family-*",
        "access": "reply",
        "instructions": ["家人消息优先响应；涉及行程时同步检查家庭日历"]
      }
    ]
  },
  "rules": [
    {
      "id": "family-now",
      "source": "wechat:family",
      "kinds": ["command", "alert"],
      "action": "run",
      "reason": "家人消息及时处理"
    },
    {
      "id": "news-digest",
      "source": "radar",
      "kinds": ["ambient"],
      "action": "digest"
    },
    {
      "id": "vip-notify",
      "source": "im:vip",
      "minPriority": 60,
      "action": "notify",
      "reason": "无需模型判断，先提醒主人"
    }
  ]
}
```

## 主动日常例程

`owner.replyRoute` 是 MimiAgent 的单一默认主动投递地址，格式与 Event route 相同：`channel` 必填，Connector 会话可再给 `target`。缺省值为 `{"channel":"system"}`，因此旧配置继续使用本机通知中心。IM 入站 Event 自带的 reply route 始终优先；System、Calendar、Radar、Files 等没有回信地址的自主任务才回落到 owner route。认证 Webhook 的 `notify:false` 是显式无回传，不会被 owner route 覆盖。Agent 创建的后续 Schedule 同样继承解析后的 route。`daemon status/attention` 只报告 channel，不返回私人 target。

`routines` 让 MimiAgent 在摘要池为空、没有新 IM 或 CLI 输入时仍能主动工作。新建配置以及缺少该字段的旧配置默认获得两条例程：每天 08:00 的 `morning-plan` 和每天 21:00 的 `evening-close`。若不需要，显式设置 `"routines": []`；也可以对单条设置 `enabled:false`。

默认晨间与晚间例程会先使用 `inspect_mimi_activity` 检查 MimiAgent 自身积压、dead letter 和近期状态变化，再检查日历、消息、天气和生活事项。该只读视图与 `mimi daemon activity [数量]` 复用同一个 Store 查询，只包含有界运行元数据，不包含其他 Event 正文、Run 答案、Outbox payload 或 target。

非 command 自主 Event 还会获得 `finish_mimi_silently(reason)`。只有完成必要检查并确认没有新变化、风险、实际动作或需要 owner 关注的事项时才应调用；成功 Event 和 Host Run 仍持久化，Event result 保存答案、usage 与有界静默原因，但不创建 Outbox。`command` Event 不注入此工具，Attention 的直接 `notify` 决策也不经过它。该状态只属于当前 attempt，失败、抢占或重试不会沿用，不需要新的表或副作用 ledger。

每条 Routine 支持：

- `id`：1～60 字符的唯一 ASCII ID，只允许字母、数字、点、下划线和连字符。
- `time`：owner `timezone` 下的 `HH:mm`。
- `weekdays`：可选 ISO weekday，1 是周一、7 是周日；缺省表示每天。
- `prompt`：最多 4000 字符的 owner 可信例程指令。
- `priority`：0～100，默认 60。
- `sessionKey`：可选稳定 Session ID，必须通过核心 Session schema；缺省时从 Routine ID 派生 `mimi-routine-*`，含点号等不兼容字符或过长 ID 会使用稳定摘要。
- `replyChannel` / `replyTarget`：可选单条覆盖；完全省略时继承 `owner.replyRoute`。只覆盖 channel 时不会沿用另一渠道的 target。

最多配置 50 条 Routine，prompt 合计最多 50000 字符，ID 不得重复。到达时点后会先生成终态 owner Conversation authority root，再生成 `attention:routine` / `schedule` / `owner` Task Event；它保留 Routine Session 为 origin，但在独立 `mimi-task-*` Session 和 OS worker 中执行，不占用原对话。externalId 包含 ID、本地日期、时间和配置 revision，因此同日重复 poll 或 Daemon 重启不会重复执行；如果 Daemon 在当天时点之后才启动，会补发当天尚未执行的例程。跨过本地午夜后才进入下一次 occurrence。删除、禁用或更新 Routine 后，已排队的旧 revision 会在调用模型前被忽略。

Routine 与其他机制分工：

- Routine：固定本地时间的主动个人运营节奏。
- Briefing：只汇总已经进入摘要池的外部事件。
- Schedule Tool：Agent 为具体事务创建一次 follow-up 或固定间隔 routine。
- Standing Orders：说明事件已经运行后，MimiAgent 应如何代表 owner 判断和行动。

Daily Routine 不必手工编辑文件。Daemon Agent 可以调用：

- `list_mimi_routines`：查看当前固定时刻任务及完整 prompt。
- `upsert_mimi_routine`：按稳定 ID 新增或完整更新；支持 time、weekdays、priority、sessionKey 和投递覆盖。
- `remove_mimi_routine`：按 ID 删除未来触发。

每次写入都会读取磁盘最新配置，完整校验 50 条数量与 50000 字符总预算，再通过 `0600` 临时文件原子替换并立即更新当前 AttentionEngine。并发工具调用在进程内串行，其他 owner 配置字段不会被覆盖；写工具进入 Event execution ledger。

Routine prompt 不应复制外部消息正文；让 Agent 在运行时按需调用 Calendar、Mail、Messages、Radar、Files 等 Connector 获取最新事实。需要静默时应明确要求先完成检查，再在确实无需打扰时调用 `finish_mimi_silently`，而不是用空答案或文本标记。`daemon attention` 只展示总数和启用数，不返回私人 prompt。

## 跨渠道人物上下文

`people` 是 owner 明确维护的轻量身份映射，让同一个人在 Mail、Messages、大象、QQ 或其他 Connector 中共享连续上下文。它不按显示名自动猜测身份，也不读取或镜像 Contacts：只有 `source + actor.id` 命中 alias 才解析为 canonical person。

每个人支持：

- `id`：1～60 字符稳定 ASCII ID，只允许字母、数字、点、下划线和连字符。
- `displayName`：最多 100 字符，只用于可信人物上下文。
- `aliases`：1～20 个 `{source, actor}`，都支持 `*` 通配符。
- `context`：最多 10 条 owner 可信关系/协作信息，单条最多 1000 字符。

最多配置 100 人，全部 context 合计最多 20000 字符；person ID 和完全相同的 alias 不得重复。按数组顺序采用第一个匹配人物，因此具体 alias 应放在通配 fallback 前。显式 Event `sessionKey` 仍然最高优先但必须通过核心 Session schema；否则从人物 ID 派生稳定安全的 `mimi-person-*`，含点号等不兼容字符或过长 ID 会使用稳定摘要。reply route 仍跟随当前事件；默认受限事件虽使用同一路由键，但 event policy 不允许读取既有 Session，命中 owner source policy 后才可使用该人物 Session 上下文。

人物 mapping/context 与 Standing Orders 一样属于本机 owner 私有配置。alias 可为跨渠道事件派生稳定安全的 Session ID；默认受限事件不会读取该 Session、注入人物 context 或携带 canonical person。owner/system 与命中 source policy 的替身 Run 可使用人物元数据和当前人物 Session；MemoryHub 读取只在 `work` 档位开放，且仍受 profile 隔离。`daemon attention` 只返回人物数和 alias 数，不返回姓名、地址或 context 正文。修改后用 `daemon attention reload` 热重载。

owner 也可在对话中使用 `list_mimi_people`、`upsert_mimi_person`、`remove_mimi_person` 完整管理人物；写入复用同一套最新文件读取、完整校验、串行原子替换和 execution ledger，成功后立即影响后续身份解析，不删除既有 Session、Memory 或历史事件。

## Standing Orders 替身决策

`decisionPolicy.standingOrders` 是全局替身指导，但不会单独给外部来源授权。`sourcePolicies` 按数组顺序检查，所有匹配项都会合并，而不是只取第一条；对外部事件而言，至少命中一条 source policy 才表示 owner 已授权 MimiAgent 在该可信策略的明确范围内代办：

- `source`：必有，默认 `*`，支持 `*` 通配符。
- `kinds`：可选的 Event kind 列表。
- `actor`：可选，匹配 Event `actor.id`，支持 `*`。
- `conversation`：可选，匹配 Event `conversation.id`，支持 `*`。
- `access`：`reply | work`，默认 `reply`。`reply` 只允许时间、计算、当前 Session 有界活动和最终回复/静默结束；`work` 才允许本地工作、网络、Connector、后台委派和 Team。
- `instructions`：1～10 条该来源专属替身规则。

全局和局部 instruction 会按配置顺序合并并去重；多个策略同时匹配时使用最高 `access`，不是把自由文本当作权限。最多 50 条全局 order、100 条 source policy；单条 instruction 最多 1000 字符，全部 instruction 合计最多 20000 字符。`daemon attention` 只显示全局条数、source policy 条数和字符数，不返回私人规则正文。修改后使用现有 `daemon attention reload` 热重载；失败时当前内存配置不变。

全局 order 也可在 owner 对话中直接管理：`list_mimi_standing_orders` 列出规则，`add_mimi_standing_order` 幂等添加，`remove_mimi_standing_order` 幂等删除。定向规则由 `list_mimi_source_policies`、`upsert_mimi_source_policy`、`remove_mimi_source_policy` 按稳定 ID 完整管理。写入沿用 Daily Routine 的最新文件读取、完整 schema 校验、进程内串行和 `0600` 原子替换，成功后立即影响后续事件；当前 owner 的明确命令仍然优先。

Standing Orders 是 owner 管理的本机可信配置，但当前 owner 的明确命令优先。它们与 `MIMI.md` 分工如下：

- `MIMI.md`：CLI 与 Daemon 共用的全局 Agent 行为、团队或项目规范。
- `assistant.json decisionPolicy`：只针对长期在线事件的替身处理原则，以及来源/人物/会话差异。

外部 Event 正文仍被单独标记为来源数据，不会因为命中了 source policy 而变成系统指令，也不能扩大目标、收件人、权限或副作用范围。`reply` 档不开放 Shell、文件写入、`http_request`、`connector_action`、后台委派或 Team；回复由原 Event 的可靠 Outbox 自动送回，不需要发送工具。`work` 档保留静态工作工具集，但仍排除策略/人物/Runtime/Connector 配置控制、Memory 写入、任意既有后台任务管理和未知 MCP。Task worker 只从仍存在且确认为 conversation root 的来源 Event 与当前 policy 重新计算授权；root/parent 缺失或指向另一个 Task 时，即使 Task 自带 owner provenance 或命中通配 policy 也强制最小策略。已接受的 Task 是执行队列，不再被 snooze、静默时段或 Attention 运行预算转成 Digest；这些限制只决定 Conversation 阶段是否接受/委派任务。Schedule occurrence 还必须与数据库中的 schedule 和 immutable Event identity 一致；撤销 external work policy 后，一次性任务只受限收尾，interval/watch 只可停止当前计划，伪造 occurrence 没有停止工具。只有 owner conversation root 的 write Task 获得 `connector_action`；外部 source-policy work Task 在后台仍可完成本地工作，但不会看到必然被 Broker 拒绝的 action 工具，完成或失败结果继续由 Outbox 原路返回。进入 Task lane 后不再开放 `delegate_background_task`，写任务拆分只用当前 Task 内的 Ultra Team，读任务只用确定性只读工具和只读 SubAgent。它不改变执行账本或 Action Bridge 不重放语义。

`source` 支持 `*` 通配符；规则按数组顺序匹配第一条。`action` 有四种：

- `run`：启动一次有界 Agent Run。
- `digest`：持久化到摘要池，等待简报。
- `notify`：不调用模型，直接按事件回传路由或系统通知提醒。
- `ignore`：记录终态但不运行、不通知。

owner 可在对话中使用 `list_mimi_attention_rules`、`upsert_mimi_attention_rule`、`remove_mimi_attention_rule` 管理这些规则。upsert 默认保留原位置，新规则默认追加；传入 `beforeId` 可将具体规则移到兜底规则之前。写入复用统一原子配置变更并立即影响后续事件。

## 摘要与简报

```bash
mimi daemon digest 50
mimi daemon brief
```

到达配置时间后，Daemon 会把尚未归档的摘要合并成一个内部 briefing 事件。批次按实际序列化 prompt 的字符预算动态选择：短项可取满 `maxItems`，大项只取能完整放入预算的前缀，剩余项继续保持未领取。简报成功完成后才会把这些摘要标为已归档；如果运行最终进入 dead letter，下一次简报会自动重新领取它们。每个计划简报时点有持久 checkpoint，重启不会重复生成同一批简报。

owner 也可以直接说“现在给我汇总一下”。`request_mimi_briefing` 会原子领取当前待处理摘要并创建同样的普通 briefing Event；工具结果只包含创建状态和路由元数据，不返回其他 Event 正文。

简报正文把所有外部 payload 明确标为不可信数据，并限制单项长度。简报默认继承 `owner.replyRoute`；需要独立目的地时可设置 `replyChannel` 和 `replyTarget`。旧配置中已有的显式 `replyChannel:"system"` 继续保持原行为。
