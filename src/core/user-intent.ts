function normalize(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
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
