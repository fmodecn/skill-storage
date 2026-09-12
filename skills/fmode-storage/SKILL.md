---
name: fmode-storage
description: "把二进制大文件（图片/音频/视频/HTML 报告）上传到对象存储（OBS/S3），本地零长期占用，生成公开分享链接。适用：(1) 报告/课件发布即分享 (2) 图片/音视频素材托管 (3) 批量上传+ACL 设置 (4) 需要公开 URL 供转发或嵌入。首次使用先跑 init 向导一次性配置 OBS 子账号 AK/SK。"
description_en: "Upload binary files (images/audio/video/HTML reports) to object storage (OBS/S3), keep local disk clean, and get public share URLs instantly. Use for publishing reports/courseware, hosting media assets, batch upload with ACL, or any scenario needing public URLs. Run the init wizard once to configure an OBS sub-account AK/SK."
---

# Fmode Storage — 对象存储与公开分享技能

## Overview

本技能把本地二进制文件交给对象存储（默认华为云 OBS，S3 协议兼容），生成公开 URL 供分享、转发或嵌入。设计原则：**本地零长期占用**——大文件直接上云；**公开即所得**——上传后立即可访问的 URL；**凭据零入库**——AK/SK 长期密钥只在 obsutil/环境配置里，诊断输出绝不含密钥本体；**诚实失败**——凭据链全失败时打印初始化向导并退出码 2，绝不伪装成功。

## 三分钟初始化（新用户）

```bash
# 1. 向 Fmode 平台/管理员申请 OBS 子账号 AK/SK（邮件模板见 README.md）
node <skill_dir>/scripts/uploader.mjs init --ak <AK> --sk <SK> \
  --endpoint obs.cn-north-4.myhuaweicloud.com --bucket <bucket>
#    （省略参数则交互询问）写 obsutil config(600)+技能 config 段，自动 test

# 2. 验证
node <skill_dir>/scripts/uploader.mjs test
# → 上传 1KB 探针文件→删除→{ "ok": true, ... }
```

## 快速用

```bash
node <skill_dir>/scripts/uploader.mjs put ./report.html --key reports/20260912/report.html
# → { "url": "https://<bucket>.<endpoint>/reports/20260912/report.html", "via": "level2:obsutilconfig(...)", ... }

node <skill_dir>/scripts/uploader.mjs setacl --key reports/ --acl public-read -r
```

## 凭据（诚实 4 级 + 端点探测）

```
┌─ 诚实 4 级（命中即用，全失败→打印初始化向导并 exit 2）────────────────────┐
│ 1. 环境变量 OBS_AK/OBS_SK(/OBS_ENDPOINT/OBS_BUCKET)                       │
│ 2. obsutil config 文件（OBSUTIL_CONFIG 或 ~/.obsutilconfig，含 getpwuid   │
│    home 变体）→ AK/SK/endpoint；bucket 缺失时 `obsutil ls` 自动探测       │
│ 3. 平台签发 STS：sessionToken + storageProjectId                          │
│    → POST /api/apig/deploy/huaweicloud（权威端点，生产实测 200）          │
│    → 项目隔离 STS，key 强制限定 dev/<projectId>/ 前缀                     │
│    （设计端点 /api/storage/credentials 从未上线——HEAD 探测 404，缓存      │
│      .sts-probe.json 1 小时；上线后 --experimental-sts 启用备用路径）     │
│ 4. 项目级 ./.fmode/config.json（obsBucket/obsEndpoint/cdnDomain）         │
└───────────────────────────────────────────────────────────────────────────┘
```

- **旧版 0.2.x "sessionToken→/api/storage/credentials 免配置自举"是伪自举**（端点从未上线，探测 404），0.3.0 已诚实化：该路径降级为 `--experimental-sts`；第3级改用真实上线的 deploy STS 端点（sessionToken + projectId）。
- **当前版本需一次性配置 AK/SK**（init 向导）；deploy STS 自举需 sessionToken + storageProjectId（免 OBS 密钥）。
- AK/SK 只存在于 obsutil config / 环境变量（用户自己配的）；`config` 命令输出不含任何密钥本体；STS 仅内存持有（临时目录 0700，命令结束即删）。

> 自建 OBS 一次性配置：`obsutil config -i=<AK> -k=<SK> -e=obs.cn-north-4.myhuaweicloud.com`
> **禁止把 AK/SK、sessionToken、STS 或任何密钥写进仓库、日志或对话。**

## 何时用

- 生成了 HTML 报告/课件要"发给别人看"→ put 后把 URL 发出
- 图片/音频/视频素材需要稳定外链 → put + setacl public-read
- 本地磁盘被大文件占满 → put 完成后可删本地原件

## 详细文档

见仓库根 `README.md`（三分钟初始化 + 多工具安装：Claude Code / Codex / Gemini CLI / WorkBuddy / Hermes + 完整 changelog）。
