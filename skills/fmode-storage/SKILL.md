---
name: fmode-storage
description: "把二进制大文件（图片/音频/视频/HTML 报告）上传到对象存储（OBS/S3），本地零长期占用，生成公开分享链接。适用：(1) 报告/课件发布即分享 (2) 图片/音视频素材托管 (3) 批量上传+ACL 设置 (4) 需要公开 URL 供转发或嵌入。第0级 sessionToken 自举换 STS 直传，无需预配 OBS 密钥。"
description_en: "Upload binary files (images/audio/video/HTML reports) to object storage (OBS/S3), keep local disk clean, and get public share URLs instantly. Use for publishing reports/courseware, hosting media assets, batch upload with ACL, or any scenario needing public URLs. Level-0 sessionToken bootstraps STS — no pre-configured OBS keys needed."
---

# Fmode Storage — 对象存储与公开分享技能

## Overview

本技能把本地二进制文件交给对象存储（默认华为云 OBS，S3 协议兼容），生成公开 URL 供分享、转发或嵌入。设计原则：**本地零长期占用**——大文件直接上云；**公开即所得**——上传后立即可访问的 URL；**凭据零入库**——STS 临时凭证仅内存持有，AK/SK 长期密钥只在 obsutil/环境配置里。

## 快速用

```bash
node <skill_dir>/scripts/uploader.mjs put ./report.html --key reports/20260911/report.html
# → { "url": "https://fmode.cn/reports/20260911/report.html", "via": "level0:sessionToken->STS", ... }

node <skill_dir>/scripts/uploader.mjs setacl --key reports/ --acl public-read -r
```

## 凭据（第0级自举 + 4 级回落）

```
┌─ 第0级（自举，推荐）──────────────────────────────────────────┐
│ FMODE_SESSION_TOKEN 或 ~/.fmode/config.json 的 sessionToken    │
│   → POST https://server.fmode.cn/api/storage/credentials      │
│   → STS 临时凭证 {AK, SK, SecurityToken}（限用户 prefix，短时）│
│   → 一次性 obsutil 临时配置直传 OBS（命令结束即删，不落盘）    │
└───────────────────────────────────────────────────────────────┘
┌─ 回落（自建 OBS / 已有 obsutil config 的用户）────────────────┐
│ 1. 环境变量 FMODE_OBS_CONF（JSON 配置文件路径）                │
│ 2. ~/.fmode/config.json → obsBucket/obsEndpoint/cdnDomain     │
│ 3. 项目 ./.fmode/config.json → 同上                           │
│ 4. obsutil 默认链（已 obsutil config 则自动探测 bucket）       │
└───────────────────────────────────────────────────────────────┘
```

- 第0级命中时**无需任何 OBS 密钥预配置**——登录 FMODE Studio 即可上传。
- STS 临时凭证：**内存持有，禁落盘、禁日志**；`runWithSts()` 用临时目录（0700）承载配置，命令结束立即删除。
- 换取失败报错：`sessionToken 缺失或失效，请重新登录 FMODE Studio 或配置 FMODE_SESSION_TOKEN`，随后自动回落第1-4级。
- 自建 OBS 用户保持原链路不变（第1-4级不受影响）。

> 自建 OBS 一次性配置：`obsutil config -i=<AK> -k=<SK> -e=obs.cn-south-1.myhuaweicloud.com`
> **禁止把 AK/SK、sessionToken、STS 或任何密钥写进仓库、日志或对话。**

## 何时用

- 生成了 HTML 报告/课件要"发给别人看"→ put 后把 URL 发出
- 图片/音频/视频素材需要稳定外链 → put + setacl public-read
- 本地磁盘被大文件占满 → put 完成后可删本地原件

## 详细文档

见仓库根 `README.md`（多工具安装：Claude Code / Codex / Gemini CLI / WorkBuddy / Hermes）。
