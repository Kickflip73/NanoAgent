---
name: send-qqmail
description: 使用系统内置的 QQ 邮箱 CLI 工具（agently-cli）发送邮件，支持文字内容和附件
---

# Send QQ Mail

使用本机 macOS 上已安装的 QQ 邮箱 CLI 工具 `agently-cli` 发送邮件。

## 前置条件

- 检查 `agently-cli` 是否可用：`which agently-cli`
- 检查是否已登录授权：`agently-cli +me`
  - 如果未登录，交互式登录：`agently-cli auth login`
- 检查返回的 `scopes` 中是否包含 `mail:send`，没有则无法发送
- 注意：发件邮箱是 `agent.qq.com` 域下的别名（如 `xxx@agent.qq.com`），收件人可以是任意 QQ 邮箱

## 发送文字邮件

```bash
# 首次调用会返回 confirmation_token，需要二次确认
agently-cli message +send \
  --to "收件人@qq.com" \
  --subject "邮件主题" \
  --body "邮件正文内容"

# 从首次调用的响应中获取 confirmation_token，带上重新发送
agently-cli message +send \
  --to "收件人@qq.com" \
  --subject "邮件主题" \
  --body "邮件正文内容" \
  --confirmation-token "ctk_xxx"
```

## 发送带附件的邮件

流程分两步：

### 1. 上传附件

附件必须是**相对路径**（不能是绝对路径），因此先将文件复制到当前目录：

```bash
cp /原路径/文件.zip ./文件.zip
```

上传附件：

```bash
agently-cli attachment +upload --file 文件.zip
```

成功后返回 `file_id`，记下备用。

### 2. 发送带附件的邮件

```bash
# 首次调用（需要确认）
agently-cli message +send \
  --to "收件人@qq.com" \
  --subject "邮件主题" \
  --body "邮件正文" \
  --attachment 文件.zip

# 带上 confirmation token 二次确认
agently-cli message +send \
  --to "收件人@qq.com" \
  --subject "邮件主题" \
  --body "邮件正文" \
  --attachment 文件.zip \
  --confirmation-token "ctk_xxx"
```

### 3. 清理临时文件

```bash
rm -f ./文件.zip
```

## 限制说明

- 单封邮件最多 **50 个附件**
- 单个附件最大 **20 MB**
- 所有附件总大小最大 **20 MB**
- 每日发送配额 **50 封**
- 每小时最多 **200 次请求**
- 每分钟最多 **10 次请求**
- 邮件正文最大 **10 MB**
- 邮件主题最大 **4 KB**

## 注意

- 发件地址是 `agent.qq.com` 域（如 `kickflip5349@agent.qq.com`），不是用户自己的 QQ 邮箱
- SPF/DKIM 由腾讯官方处理，无需额外配置
- 发送成功返回 `{"ok": true, "data": {"queued": true}}`
- 发送是队列模式（异步投递），通常几秒到几分钟内到达
