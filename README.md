# skill-storage · 对象存储与公开分享技能

> AI Agent 的"仓库管理员"——二进制大文件（图片/音频/视频/报告 HTML）上云，本地零占用，一键生成公开分享链接。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 能力

- 📤 大文件上传对象存储（华为云 OBS / S3 协议），本地磁盘零长期占用
- 🔗 生成公开分享链接（`https://<域名>/<key>` 形态，可配 CDN）
- 📄 报告/课件 HTML 发布即分享（传完即得可转发 URL）
- 🧹 生命周期管理（前缀用量统计/批量清理/ACL 设置）

## 各工具安装

### Claude Code
```bash
git clone https://git.fmode.cn/fmode/skill-storage.git
cp -r skill-storage/skills/fmode-storage ~/.claude/skills/fmode-storage
```
之后在会话里直接说：「把这个报告上传并给我公开链接」。

### Codex / Gemini CLI
把 `skills/fmode-storage/SKILL.md` 的内容并入 `AGENTS.md`（Codex）或 `~/.gemini/commands/storage.toml`（Gemini CLI，prompt 段引用 scripts/uploader.mjs）。

### WorkBuddy / Hermes
```bash
git clone https://git.fmode.cn/fmode/skill-storage.git
cp -r skill-storage/skills/fmode-storage <你的工具技能目录>/fmode-storage
```

## 凭据（第0级 sessionToken 自举 + 4 级回落，零密钥入库）

凭据解析链（命中即用，检测不到就换下一级，绝不空转）：

```
第0级（自举）: sessionToken（FMODE_SESSION_TOKEN 环境变量
                              或 ~/.fmode/config.json 的 sessionToken
                              或 ~/.fmode/config/user.json）
             → POST https://server.fmode.cn/api/storage/credentials
             → STS 临时凭证 {AK, SK, SecurityToken}（作用域限定用户 prefix，短时）
             → 一次性 obsutil 临时配置直传 OBS（STS 不落盘、不进日志，用完即删）
             ✅ 登录 FMODE Studio 即可上传，无需预配任何 OBS 密钥
第1级: 环境变量 FMODE_OBS_CONF（OBS util 配置文件路径）
第2级: ~/.fmode/config.json → obsUtilPath / obsBucket / obsEndpoint / cdnDomain
第3级: 项目 ./.fmode/config.json → 同上
第4级: 华为云 SDK 默认链（若装了 obsutil/huaweicloud-sdk 且已 obsutil config）
```

- **STS 临时凭证只在内存持有**：不写文件（除一次性临时配置目录，命令结束即删）、不打日志、不进错误信息与诊断输出。
- 第0级换取失败时明确报错：`sessionToken 缺失或失效，请重新登录 FMODE Studio 或配置 FMODE_SESSION_TOKEN`，随后自动回落第1-4级——已配置的自建 OBS 用户完全不受影响。

> 自建 OBS 配置方法（一次性，第1-4级回落）：`obsutil config -i=<AK> -k=<SK> -e=obs.cn-south-1.myhuaweicloud.com`
> **不要把 AK/SK、sessionToken、STS 写进本仓库或任何对话。**

## 用法示例

```bash
# 上传并输出公开链接
node skills/fmode-storage/scripts/uploader.mjs put ./report.html --key reports/20260911/report.html
# → https://fmode.cn/reports/20260911/report.html

# 设置公开读
node skills/fmode-storage/scripts/uploader.mjs setacl --key reports/ --acl public-read -r
```

## License

MIT
