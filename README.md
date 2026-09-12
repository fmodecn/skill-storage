# skill-storage · 对象存储与公开分享技能

> AI Agent 的"仓库管理员"——二进制大文件（图片/音频/视频/报告 HTML）上云，本地零占用，一键生成公开分享链接。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 三分钟初始化（新用户必读）

**当前版本（0.3.0）需一次性配置 OBS 子账号 AK/SK；sessionToken 免配置自举待平台端点上线**（设计文档 `fmode-studio/docs/obs-cdn/04-API设计.md` 中 `/api/storage/credentials` 状态为"规划中"，本技能启动时会自动探测：404=未上线则跳过该级并提示，端点上线后 `--experimental-sts` 一行启用）。

### 步骤 1：向平台/管理员申请 OBS 子账号（约 1 分钟）

给管理员发一封邮件/消息（模板直接用）：

> 主题：申请 OBS 子账号（skill-storage 上传用）
>
> 你好，我需要用 skill-storage 技能把报告/素材上传到对象存储并生成公开链接。请按最小权限为我开通一个 OBS 子账号：
> 1. AK/SK（仅授予桶 `<bucket>` 的 PutObject / DeleteObject / PutObjectAcl 权限，建议限定前缀 `skill-storage/`）
> 2. 桶名与终端节点（endpoint，如 obs.cn-north-4.myhuaweicloud.com）
> 3. 如有 CDN 域名请一并提供

### 步骤 2：执行 init 向导（约 1 分钟）

```bash
node skills/fmode-storage/scripts/uploader.mjs init \
  --ak <你的AK> --sk <你的SK> \
  --endpoint obs.cn-north-4.myhuaweicloud.com \
  --bucket <bucket>
# 省略参数则进入交互模式逐项询问
```

写入 `~/.obsutilconfig`（600 权限）+ `~/.fmode/config.json` 技能 config 段（不含密钥本体），随后自动执行 test。

### 步骤 3：验证（约 30 秒）

```bash
node skills/fmode-storage/scripts/uploader.mjs test
# → 上传 1KB 探针文件 → 删除 → { "ok": true, ... }
```

## 能力

- 📤 大文件上传对象存储（华为云 OBS / S3 协议），本地磁盘零长期占用
- 🔗 生成公开分享链接（`https://<域名>/<key>` 形态，可配 CDN）
- 📄 报告/课件 HTML 发布即分享（传完即得可转发 URL）
- 🧪 自检：`test` 命令上传→删除探针文件全链验证
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

## 凭据（诚实 4 级，零密钥入库）

凭据解析链（命中即用，检测不到就换下一级；**全失败打印初始化向导并退出码 2，绝不伪装成功**）：

```
第1级: 环境变量 OBS_AK/OBS_SK（可选 OBS_ENDPOINT/OBS_BUCKET）
第2级: obsutil config 文件（OBSUTIL_CONFIG 环境变量 或 ~/.obsutilconfig，
       含 getpwuid home 变体）——解析出 AK/SK/endpoint，bucket 缺失时用
       `obsutil ls` 自动探测
第3级: ~/.fmode/config/user.json 的 fmodeApiToken → 平台签发接口
       （启动时 HEAD 探测 ${FMODE_API_BASE}/api/storage/credentials 并缓存
       .sts-probe.json 1 小时：404=未上线 → 打印"平台 STS 签发端点未上线
       (设计文档 04-API设计.md), 暂用 obsutil 配置模式"并跳过，不空转）
第4级: 项目级 ./.fmode/config.json（obsBucket/obsEndpoint/cdnDomain）
```

- **平台 STS 签发端点目前未上线（探测 404）**。旧版"sessionToken→STS 自举"声称"登录即可上传"属伪自举，0.3.0 已诚实化：代码保留，仅在显式传 `--experimental-sts` 且端点探测 200 时启用（面向未来上线）。B 节接口上线后一行配置恢复。
- **AK/SK 长期密钥只存在于 obsutil config / 环境变量**（用户自己配的）；`config` 命令诊断输出绝不含任何密钥本体。
- **当前版本需一次性配置 AK/SK**（见顶部"三分钟初始化"）；sessionToken 免配置自举待平台端点上线。

> 自建 OBS 配置方法（一次性，第2级）：`obsutil config -i=<AK> -k=<SK> -e=obs.cn-north-4.myhuaweicloud.com`
> **不要把 AK/SK、sessionToken、STS 写进本仓库或任何对话。**

## 用法示例

```bash
# 初始化（一次性）
node skills/fmode-storage/scripts/uploader.mjs init --ak <AK> --sk <SK> --endpoint ... --bucket ...

# 自检
node skills/fmode-storage/scripts/uploader.mjs test

# 上传并输出公开链接
node skills/fmode-storage/scripts/uploader.mjs put ./report.html --key reports/20260912/report.html
# → https://<bucket>.<endpoint>/reports/20260912/report.html

# 设置公开读
node skills/fmode-storage/scripts/uploader.mjs setacl --key reports/ --acl public-read -r

# 诊断（不含任何密钥本体）
node skills/fmode-storage/scripts/uploader.mjs config
```

## Changelog

### 0.3.0（凭据链语义变更）
- **真因修复**：旧版第0级调用 `POST /api/storage/credentials` 换 STS —— 该端点**从未上线（404）**（设计文档 `fmode-studio/docs/obs-cdn/04-API设计.md`，status:规划中），"登录即可上传"是伪自举
- 字段名纠错：真实身份字段是 `~/.fmode/config/user.json` 的 **fmodeApiToken**（sk- 开头），不是 sessionToken
- "能跑通"假象纠偏：部分环境"能跑"只是因为历史遗留的手工 obsutilconfig 存在（第1/2级回落生效），其他机器无此文件即全链死——现在全链失败时明确打印初始化向导并退出码 2，不再伪装成功
- 凭据链重写为诚实 4 级（env → obsutil config → 平台签发(端点探测) → 项目 config），旧自举降级为 `--experimental-sts`（端点 200 才启用）
- 新增 `init` 向导（写 obsutil config 600 权限 + 技能 config 段 + 自动 test）与 `test` 自检命令
- 端点探测结果缓存 `.sts-probe.json`（1 小时有效，已 gitignore）
- 修复：失败判定误报（旧版 `chattri` 失败文案含 "Set the acl" 被误判成功；`OBSUTIL_CONFIG_FILE` 环境变量 obsutil 并不识别，改用 `-config=` 显式传递）；obsutil 不在 PATH 时自动按 `~/.local/bin`、`~/bin`、getpwuid home 等候选定位

### 0.2.1
- 修复 mjs 双 shebang 语法错误

### 0.1.0
- 首版：对象存储上传/公开链接/ACL，4 级凭据解析，多工具指南

## License

MIT
