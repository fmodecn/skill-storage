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

## 凭据（零密钥入库）

运行器按优先级自动解析（检测不到就换下一级，绝不空转）：

1. 环境变量 `FMODE_STORAGE_TOKEN` / `FMODE_OBS_CONF`（OBS util 配置文件路径）
2. `~/.fmode/config.json` → `obsUtilPath` / `obsBucket` / `obsEndpoint` / `cdnDomain`
3. 项目 `./.fmode/config.json` → 同上
4. 华为云 SDK 默认链（若装了 obsutil/huaweicloud-sdk 且已 `obsutil config`）

> obsutil 配置方法（一次性）：`obsutil config -i=<AK> -k=<SK> -e=obs.cn-south-1.myhuaweicloud.com`
> **不要把 AK/SK 写进本仓库或任何对话。**

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
