function normalize(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export type UserCapabilityDisclosure = 'status' | 'session' | 'web' | 'lightweight' | 'full';

export function capabilityDisclosureForInput(input: string): UserCapabilityDisclosure {
  const value = normalize(input);
  if (explicitlyRequestsMemory(value) || explicitlyRequestsHistoricalEvidence(value)
    || /(?:忘记|删除).{0,12}(?:记忆|偏好|memory)|\bforget\b.{0,20}\bmemor/iu.test(value)) {
    return 'full';
  }
  const compound = /(?:然后|并且|同时|接着|之后|再(?:去|来|把|帮|继续|修改|修复)|[,，;；]|\b(?:and|then|also)\b)/iu.test(value);
  const sessionIntent = explicitlyRequestsSessionAccess(value) || explicitlyRequestsSessionClear(value)
    || /(?:切换|更换|选择).{0,12}(?:模型|模式)|(?:模型|模式|输出等级).{0,12}(?:切换|更换|选择|调整)|(?:当前|现在|正在).{0,8}(?:使用|用的)?(?:模型|模式)|你.{0,8}用.{0,8}(?:模型|模式)|\b(?:switch|change|select|current).{0,16}(?:model|mode)|\/(?:model|mode|output)\b/iu.test(value);
  const statusIntent = value.length <= 80 && (
    /(?:咋样了|怎么样了|开始了没|开始了吗|完成了没|完成了吗|好了吗|到哪了|什么状态|还在.{0,8}吗|进度.{0,8}(?:呢|如何|怎样|怎么样|咋样|多少|到哪)|how(?:'s| is).{0,16}going)\s*[?？!！。]*$/iu.test(value)
    || /^(?:(?:请|帮我)?(?:列出|查看|看看|查下)?\s*)?(?:当前|最近|所有)?(?:后台)?任务(?:列表|状态)?\s*[?？!！。]*$/iu.test(value)
    || /^(?:what(?:'s| is)\s+the\s+)?(?:progress|status)(?:\s+now)?\s*[?!.]*$/iu.test(value)
  );
  if (compound && (sessionIntent || statusIntent)) return 'full';
  if (sessionIntent) {
    return 'session';
  }
  if (statusIntent) return 'status';
  const concreteArtifact = /(?:项目|代码|文件|目录|仓库|分支|提交|日志|数据库|终端|命令|脚本|进程|应用|窗口|桌面|浏览器|网页|链接|邮件|消息|日程|提醒|README|CHANGELOG|package\.json|Mimi|Agent|(?:^|[\s`'"(])(?:src|tests?|docs?|skills?)\/|https?:\/\/|\b[\w.-]+\.(?:ts|tsx|js|mjs|json|md|py|sh|sql)\b)/iu.test(value);
  const problemArtifact = /(?:报错|错误|bug|error|exception|failure)/iu.test(value);
  const strongAction = /(?:修复|排查|修改|编辑|创建|新建|删除|清空|保存|写入|移动|重命名|运行|执行|测试|构建|安装|下载|上传|部署|发布|打开|关闭|点击|输入|发送|回复|提醒|安排|预订|导出|提交|推送|操作|控制|实现|生成|制作|更新|配置|取消|暂停|恢复|继续|开始吧|照做|弄好|搞定|处理)|(?:给|向).{0,30}发(?:送)?|用方案|\b(?:fix|debug|modify|edit|create|delete|write|move|rename|run|execute|test|build|install|download|upload|deploy|publish|open|close|click|send|reply|remind|export|commit|push|implement|generate|configure|cancel|pause|resume|continue|proceed)\b/iu.test(value);
  const inspectAction = /(?:读取|分析|审查|检查|验证|查看|看看|看下|看一下|查下|搜索|解释|总结|对比|优化|重构|read|analy[sz]e|review|inspect|verify|explain|summari[sz]e|compare|search|refactor|optimi[sz]e)/iu.test(value);
  const informational = /(?:如何|怎么|怎样|为什么|解释|介绍|说明|什么是|区别|原理|含义|优缺点)|\b(?:how|why|what|explain|describe|introduce)\b/iu.test(value);
  if ((concreteArtifact && (strongAction || inspectAction))
    || (problemArtifact && !informational && (strongAction || inspectAction))
    || (strongAction && !informational)) return 'full';
  if (/(?:搜索|搜一下|查一下|查查|最新|新闻|天气|价格|汇率|实时|search|look\s*up|latest|news|weather|price|exchange rate)/iu.test(value)) {
    return 'web';
  }
  if (/^(?:你好|您好|嗨|hello|hi|谢谢|多谢|好的|明白了|知道了|你是谁|讲个笑话)\s*[!！。.?？]*$/iu.test(value)
    || informational) return 'lightweight';
  return 'full';
}

function hasNegatedAction(input: string, actions: string): boolean {
  const chinese = new RegExp(`(?:不要|别|请勿|不想|不希望|无需|不需要|禁止|拒绝|取消).{0,40}(?:${actions})`, 'iu');
  const english = new RegExp(`(?:do not|don't|dont|never|please\\s+don't|not\\s+(?:want|wish|asking)).{0,60}(?:${actions})`, 'iu');
  return chinese.test(input) || english.test(input);
}

export function explicitlyRequestsMemory(input: string): boolean {
  const value = normalize(input);
  const actions = '记住|保存|长期记忆|remember|save';
  if (hasNegatedAction(value, actions)) return false;
  if (/(?:还|已经|曾经|目前|现在).{0,12}(?:记住|记得).{0,12}(?:什么|哪些|多少)|(?:记住|记得).{0,8}(?:什么|哪些)|(?:what|which).{0,24}(?:remember|memor(?:y|ies))/iu.test(value)) {
    return false;
  }
  return /^(?:(?:好的?[,，。]?|请(?:你)?|请帮我|帮我|麻烦(?:你)?|我想(?:让你)?|我希望你)\s*)?(?:记住|保存.{0,10}(?:为|到)?(?:长期)?记忆|下次.{0,10}(?:记得|提醒))|^(?:please\s+)?(?:remember\b|save\b.{0,20}(?:memory|for later))|^i\s+(?:want|would like)\s+you\s+to\s+(?:remember|save)\b/iu.test(value);
}

export function explicitlyForbidsMemory(input: string): boolean {
  return hasNegatedAction(normalize(input), '记住|保存|长期记忆|remember|save');
}

export function explicitlyRequestsSessionAccess(input: string): boolean {
  const value = normalize(input);
  const actions = '列出|查看|选择|切换|恢复|继续|打开|新建|创建|list|show|switch|resume|open|new|create';
  if (hasNegatedAction(value, actions)) return false;
  return /(?:\/(?:sessions|switch|new)\b|(?:列出|查看|选择|切换|恢复|继续|打开|新建|创建).{0,12}(?:会话|对话|session)|(?:会话|对话|session).{0,12}(?:列表|切换|恢复|继续|打开|新建|创建)|(?:list|show|switch|resume|open|new|create)\s+(?:the\s+)?sessions?)/iu.test(value);
}

export function explicitlyRequestsSessionClear(input: string): boolean {
  const value = normalize(input);
  const actions = '清空|删除|重置|clear|delete|reset';
  if (hasNegatedAction(value, actions)) return false;
  return /(?:^|[，。！？,.!?]\s*)(?:请(?:你)?|请帮我|帮我|麻烦(?:你)?|please\s+)?(?:清空|删除|重置).{0,12}(?:当前)?(?:会话|对话|聊天|历史)|(?:^|[.!?]\s*)(?:please\s+)?(?:clear|delete|reset).{0,16}(?:current\s+)?(?:session|conversation|chat|history)|\/clear\b/iu.test(value);
}

export function explicitlyRequestsHistoricalEvidence(input: string): boolean {
  const value = normalize(input);
  const actions = '查看|读取|搜索|回顾|回忆|引用|核对|找出|read|search|review|recall|quote|check';
  if (hasNegatedAction(value, actions)) return false;
  return /(?:之前|过去|上次|较早|历史|以前|曾经).{0,24}(?:会话|对话|聊天|原话|记录|讨论|说过|提到)|(?:会话|对话|聊天|session|conversation|history).{0,24}(?:历史|记录|原文|之前|过去|earlier|previous|past)|(?:read|search|review|recall|quote|check).{0,24}(?:earlier|previous|past).{0,12}(?:session|conversation|chat)/iu.test(value);
}
