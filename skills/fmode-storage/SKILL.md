---
name: fmode-storage
description: "把二进制大文件（图片/音频/视频/HTML 报告）上传到对象存储（OBS/S3），本地零长期占用，生成公开分享链接。适用：(1) 报告/课件发布即分享 (2) 图片/音视频素材托管 (3) 批量上传+ACL 设置 (4) 需要公开 URL 供转发或嵌入。AK/SK 用 obsutil config 配置，凭据不入库。"
description_en: "Upload binary files (images/audio/video/HTML reports) to object storage (OBS/S3), keep local disk clean, and get public share URLs instantly. Use for publishing reports/courseware, hosting media assets, batch upload with ACL, or any scenario needing public URLs."
---

# Fmode Storage — 对象存储与公开分享技能

## Overview

本技能把本地二进制文件交给对象存储（默认华为云 OBS，S3 协议兼容），生成公开 URL 供分享、转发或嵌入。设计原则：**本地零长期占用**——大文件直接上云；**公开即所得**——上传后立即可访问的 URL；**凭据零入库**——AK/SK 只在 obsutil/环境配置里。

## 快速用

```bash
node <skill_dir>/scripts/uploader.mjs put ./report.html --key reports/20260911/report.html
# → { "url": "https://fmode.cn/reports/20260911/report.html", ... }

node <skill_dir>/scripts/uploader.mjs setacl --key reports/ --acl public-read -r
```

## 凭据（4 级自动解析）

1. 环境变量 `FMODE_OBS_CONF`（JSON 文件路径）
2. `~/.fmode/config.json` → `obsBucket` / `obsEndpoint` / `cdnDomain` / `obsUtilPath`
3. 项目 `./.fmode/config.json`
4. obsutil 默认链（已 `obsutil config` 则自动探测 bucket）

> AK/SK 配置一次：`obsutil config -i=<AK> -k=<SK> -e=obs.cn-south-1.myhuaweicloud.com`
> **禁止把 AK/SK 或任何密钥写进仓库、日志或对话。**

## 何时用

- 生成了 HTML 报告/课件要"发给别人看"→ put 后把 URL 发出
- 图片/音频/视频素材需要稳定外链 → put + setacl public-read
- 本地磁盘被大文件占满 → put 完成后可删本地原件

## 详细文档

见仓库根 `README.md`（多工具安装：Claude Code / Codex / Gemini CLI / WorkBuddy / Hermes）。
