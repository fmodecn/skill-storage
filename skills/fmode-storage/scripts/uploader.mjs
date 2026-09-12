#!/usr/bin/env node
/**
 * fmode-storage uploader — 对象存储上传/公开链接/ACL
 * 零依赖（Node ≥18）。凭据按 4 级优先级自动解析，永不入库。
 *
 * v0.3.0 诚实凭据链（真因修复，见 CHANGELOG.md）：
 *   旧版第0级调用 POST /api/storage/credentials —— 该端点从未上线（404，
 *   设计文档 fmode-studio/docs/obs-cdn/04-API设计.md 状态为"规划中"），
 *   "登录即可上传"是伪自举。本版改为：
 *
 *   第1级 环境变量 OBS_AK/OBS_SK(/OBS_ENDPOINT/OBS_BUCKET)
 *   第2级 obsutil config 文件（OBSUTIL_CONFIG 或 ~/.obsutilconfig）解析 AK/SK/endpoint/bucket
 *   第3级 ~/.fmode/config/user.json 的 fmodeApiToken → 平台签发接口
 *         （启动时 HEAD 探测该端点：404=未上线→跳过并提示；200=启用自举）
 *   第4级 项目级 ./.fmode/config.json
 *   全失败：打印初始化向导指引并退出码 2，绝不伪装成功。
 *
 *   旧 sessionToken 自举保留为 --experimental-sts：仅当显式传入该参数
 *   且端点探测返回 200 时启用（面向未来端点上线，默认关闭）。
 *
 * 用法:
 *   node uploader.mjs init [--ak ... --sk ... --endpoint ... --bucket ...]
 *   node uploader.mjs put <file> --key <objectKey> [--acl public-read] [--endpoint ...] [--bucket ...]
 *   node uploader.mjs setacl --key <prefix|key> --acl public-read [-r]
 *   node uploader.mjs test
 *   node uploader.mjs config
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HOME = os.homedir();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// fmode 网关基址（平台 STS 签发端点所在）
const FMODE_API_BASE = process.env.FMODE_API_BASE || 'https://server.fmode.cn';
const STORAGE_CREDENTIALS_URL = `${FMODE_API_BASE.replace(/\/$/, '')}/api/storage/credentials`;
const DEFAULT_ENDPOINT = 'obs.cn-north-4.myhuaweicloud.com';
const PROBE_CACHE_FILE = path.join(__dirname, '.sts-probe.json'); // 探测结果缓存（1 小时有效）
const PROBE_TTL_MS = 60 * 60 * 1000;

/** 打印初始化向导（全链失败时的唯一出口，绝不伪装成功） */
function printWizard() {
  console.error(`
┌─ fmode-storage 初始化向导 ─────────────────────────────────────────────┐
│ 当前版本需一次性配置 OBS 子账号 AK/SK；sessionToken 免配置自举待平台    │
│ 端点上线（设计文档 fmode-studio/docs/obs-cdn/04-API设计.md，规划中）。  │
├────────────────────────────────────────────────────────────────────────┤
│ 步骤 1  向 Fmode 平台/管理员申请 OBS 子账号（邮件模板见 README.md       │
│         "三分钟初始化"章节），拿到 AK/SK 及所属桶/终端节点。            │
│ 步骤 2  执行初始化（任选其一）：                                        │
│           node uploader.mjs init --ak <AK> --sk <SK> \\                 │
│               --endpoint obs.cn-north-4.myhuaweicloud.com \\           │
│               --bucket <bucket>                                        │
│         （省略参数则进入交互模式逐项询问）                              │
│ 步骤 3  验证：node uploader.mjs test                                    │
│         （上传 1KB 探针文件→删除→报告成功）                             │
└────────────────────────────────────────────────────────────────────────┘`);
}

// ============================================================================
// 平台签发端点探测（B 节：诚实探测 + 1 小时缓存）
// ============================================================================

/**
 * HEAD 探测平台 STS 签发端点是否上线。结果缓存本文件 .sts-probe.json（1 小时）。
 * @returns {Promise<{online: boolean, checkedAt: number, status: number|null}>}
 */
export async function probeStsEndpoint() {
  // 读缓存
  try {
    const j = JSON.parse(fs.readFileSync(PROBE_CACHE_FILE, 'utf8'));
    if (j.checkedAt && Date.now() - j.checkedAt < PROBE_TTL_MS) return j;
  } catch { /* 无缓存或损坏 → 重新探测 */ }
  let status = null;
  try {
    const res = await fetch(STORAGE_CREDENTIALS_URL, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    status = res.status;
  } catch { /* 网络失败视为未上线，不给假希望 */ }
  const result = { online: status === 200, checkedAt: Date.now(), status };
  try { fs.writeFileSync(PROBE_CACHE_FILE, JSON.stringify(result)); } catch { /* 只读环境忽略 */ }
  return result;
}

/** 探测缓存是否可以强制刷新（--refresh-probe / init / test 命令场景） */
function invalidateProbeCache() {
  try { fs.rmSync(PROBE_CACHE_FILE, { force: true }); } catch { /* ignore */ }
}

// ============================================================================
// 旧第0级自举（--experimental-sts 专用，端点上线前是死代码路径）
// ============================================================================

/**
 * 解析 sessionToken（优先级：FMODE_SESSION_TOKEN → ~/.fmode config 文件）。
 * 注意：真实身份字段是 fmodeApiToken（sk- 开头），本函数仅在
 * --experimental-sts 且端点探测 200 时被调用，面向未来端点上线。
 */
export function resolveSessionToken() {
  if (process.env.FMODE_SESSION_TOKEN) return process.env.FMODE_SESSION_TOKEN.trim();
  const candidates = [
    path.join(HOME, '.fmode', 'config.json'),
    path.join(process.cwd(), '.fmode', 'config.json'),
    path.join(HOME, '.fmode', 'config', 'user.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
      const t = j.sessionToken || (j.user && j.user.sessionToken) || null;
      if (t && String(t).trim()) return String(t).trim();
    } catch { /* try next source */ }
  }
  return null;
}

/**
 * sessionToken → STS 临时凭证。⚠️ 端点未上线（404）前必然返回 null。
 * 返回的 STS 仅内存持有：不写文件、不打日志、不进错误信息。
 */
export async function fetchStsCredentials(sessionToken) {
  if (!sessionToken) return null;
  try {
    const res = await fetch(STORAGE_CREDENTIALS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ op: ['put', 'delete'] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const cred = body && (body.credentials || body.data);
    if (!cred || !cred.accessKeyId || !cred.secretAccessKey) return null;
    return {
      ak: cred.accessKeyId,
      sk: cred.secretAccessKey,
      securityToken: cred.sessionToken || cred.securityToken || '',
      endpoint: cred.endpoint || DEFAULT_ENDPOINT,
      bucket: cred.bucket || null,
      prefix: cred.prefix || '',
    };
  } catch { return null; }
}

/**
 * 用 STS 临时凭证构造一次性 obsutil 配置目录，执行命令后即删。
 * （配置经 -config= 显式传给 obsutil——旧版 OBSUTIL_CONFIG_FILE 环境变量
 *  obsutil 并不识别，属无效传递，本版修正。）
 */
export function runWithSts(sts, args, timeout = 300000) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmode-sts-'));
  fs.chmodSync(tmpDir, 0o700);
  const cfgFile = path.join(tmpDir, '.obsutilconfig');
  fs.writeFileSync(cfgFile, [
    `endpoint=${sts.endpoint}`,
    `ak=${sts.ak}`,
    `sk=${sts.sk}`,
    `token=${sts.securityToken}`,
    '',
  ].join('\n'), { mode: 0o600 });
  try {
    return runObsutil(cfg.obsUtilPath, args, { cfgFile, timeout });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ============================================================================
// obsutil 执行层
// ============================================================================

/** 统一 obsutil 调用。成功判定用退出码 + 末行无 "failed"，杜绝"failed"文案误判为成功。 */
function runObsutil(obsUtilPath, args, { cfgFile = null, timeout = 120000 } = {}) {
  const r = spawnSync(obsUtilPath, [...args, ...(cfgFile ? [`-config=${cfgFile}`] : [])], {
    encoding: 'utf8',
    timeout,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0 && !/failed/i.test(out.split('\n').filter(Boolean).pop() || '');
  return { ok, out, status: r.status };
}

/** 公开 URL: cdnDomain 优先, 否则桶域名 */
export function publicUrl(cfg, key) {
  if (cfg.cdnDomain) return `https://${cfg.cdnDomain}/${key}`;
  return `https://${cfg.bucket}.${cfg.endpoint}/${key}`;
}

// ============================================================================
// 凭据链：诚实 4 级
// ============================================================================

/** 解析 obsutil config 文件内容 → {endpoint, ak, sk, token, bucket}。密钥不外泄，仅内部使用。 */
function parseObsutilConfig(text) {
  const c = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(endpoint|ak|sk|token)=(.*)$/);
    if (m) c[m[1]] = m[2].trim();
  }
  return (c.ak && c.sk) ? c : null;
}

/** obsutil config 文件候选路径（OBSUTIL_CONFIG 环境变量优先，其次 ~/.obsutilconfig） */
function obsutilConfigPaths() {
  const paths = [];
  if (process.env.OBSUTIL_CONFIG) paths.push(process.env.OBSUTIL_CONFIG);
  paths.push(path.join(HOME, '.obsutilconfig'));
  // getpwuid 的 home 可能与 $HOME 不同（容器常见）：obsutil 实际按它解析默认配置
  try {
    const pwHome = os.userInfo().homedir;
    if (pwHome && pwHome !== HOME) paths.push(path.join(pwHome, '.obsutilconfig'));
  } catch { /* ignore */ }
  return paths;
}

/** 定位 obsutil 可执行文件：PATH → ~/.local/bin → ~/bin → getpwuid home/bin → /usr/local/bin */
function findObsutil() {
  const candidates = [];
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir) candidates.push(path.join(dir, 'obsutil'));
  }
  for (const base of [path.join(HOME, '.local', 'bin'), path.join(HOME, 'bin')]) candidates.push(path.join(base, 'obsutil'));
  try {
    const pwHome = os.userInfo().homedir;
    if (pwHome && pwHome !== HOME) candidates.push(path.join(pwHome, 'bin', 'obsutil'));
  } catch { /* ignore */ }
  candidates.push('/usr/local/bin/obsutil', '/usr/bin/obsutil');
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return 'obsutil'; // 交给 spawnSync 报"not found"
}

/**
 * 诚实 4 级凭据解析（命中即用，检测不到就换下一级）：
 *   第1级 环境变量 OBS_AK/OBS_SK(/OBS_ENDPOINT/OBS_BUCKET)
 *   第2级 obsutil config 文件（OBSUTIL_CONFIG 或 ~/.obsutilconfig）
 *   第3级 ~/.fmode/config/user.json 的 fmodeApiToken → 平台签发接口
 *         （先 HEAD 探测端点：404=未上线→跳过并提示，不空转）
 *   第4级 项目级 ./.fmode/config.json
 */
export async function resolveStorageConfig({ experimentalSts = false } = {}) {
  const cfg = {
    obsUtilPath: 'obsutil',
    endpoint: DEFAULT_ENDPOINT,
    bucket: null,
    cdnDomain: null,
    sts: null,
    via: null,       // 命中的解析级别（诊断用，不含任何密钥）
    ak: null,        // 内部传递用，config 命令绝不输出
    sk: null,
    token: '',
  };
  cfg.obsUtilPath = findObsutil();

  // ---- 第1级：环境变量 ----
  if (process.env.OBS_AK && process.env.OBS_SK) {
    cfg.ak = process.env.OBS_AK.trim();
    cfg.sk = process.env.OBS_SK.trim();
    if (process.env.OBS_ENDPOINT) cfg.endpoint = process.env.OBS_ENDPOINT.trim();
    if (process.env.OBS_BUCKET) cfg.bucket = process.env.OBS_BUCKET.trim();
    cfg.via = 'level1:env(OBS_AK/OBS_SK)';
  }

  // ---- 第2级：obsutil config 文件 ----
  if (!cfg.ak) {
    for (const p of obsutilConfigPaths()) {
      try {
        if (!fs.existsSync(p)) continue;
        const c = parseObsutilConfig(fs.readFileSync(p, 'utf8'));
        if (c) {
          cfg.ak = c.ak; cfg.sk = c.sk; cfg.token = c.token || '';
          if (c.endpoint) cfg.endpoint = c.endpoint;
          cfg.via = `level2:obsutilconfig(${p})`;
          break;
        }
      } catch { /* try next path */ }
    }
  }

  // ---- 第3级：fmodeApiToken → 平台签发接口（端点未上线则跳过并提示）----
  if (!cfg.ak) {
    const userCfg = path.join(HOME, '.fmode', 'config', 'user.json');
    const token = (() => {
      try {
        const j = JSON.parse(fs.readFileSync(userCfg, 'utf8').replace(/^﻿/, ''));
        return (j.fmodeApiToken || '').trim() || null;
      } catch { return null; }
    })();
    if (token) {
      const probe = await probeStsEndpoint();
      if (!probe.online) {
        console.error(`平台 STS 签发端点未上线（探测 ${STORAGE_CREDENTIALS_URL} → ${probe.status ?? '网络失败'}；设计文档 fmode-studio/docs/obs-cdn/04-API设计.md 状态"规划中"），暂用 obsutil 配置模式`);
      } else if (experimentalSts) {
        const sts = await fetchStsCredentials(token);
        if (sts) {
          cfg.sts = sts;
          cfg.endpoint = sts.endpoint || cfg.endpoint;
          cfg.bucket = sts.bucket || cfg.bucket;
          cfg.via = 'level3:experimental-sts';
          return cfg;
        }
        console.error('--experimental-sts 已启用且端点在线，但换取失败：token 缺失或失效');
      } else {
        console.error('平台 STS 端点已上线。加 --experimental-sts 启用 sessionToken 自举（或等待默认开启）。');
      }
    }
  }

  // ---- 第4级：项目级 ./.fmode/config.json ----
  if (!cfg.ak && !cfg.sts) {
    try {
      const p = path.join(process.cwd(), '.fmode', 'config.json');
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.obsUtilPath) cfg.obsUtilPath = j.obsUtilPath;
      if (j.obsBucket) { cfg.bucket = j.obsBucket; cfg.via = `level4:${p}`; }
      if (j.obsEndpoint) cfg.endpoint = j.obsEndpoint;
      if (j.cdnDomain) cfg.cdnDomain = j.cdnDomain;
    } catch { /* ignore */ }
  }

  // ---- bucket 补全：第1/2级命中但缺 bucket → obsutil ls 探测 ----
  if (cfg.ak && !cfg.bucket) {
    try {
      const out = execSync(`${JSON.stringify(cfg.obsUtilPath)} ls -limit=1`, { encoding: 'utf8', timeout: 15000 });
      const m = out.match(/obs:\/\/([^/\s]+)/);
      if (m) { cfg.bucket = m[1]; cfg.via += '+bucket-probe'; }
    } catch { /* 探测失败交给上层报错 */ }
  }

  return cfg;
}

// ============================================================================
// 初始化向导（C 节：新用户路径）
// ============================================================================

/**
 * node uploader.mjs init [--ak ... --sk ... --endpoint ... --bucket ...]
 * 写入 obsutil config（600 权限）+ 本技能 config 段，然后立即 test。
 */
async function cmdInit(rest) {
  const arg = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
  const ask = async (q) => {
    process.stdout.write(q);
    let buf = '';
    for await (const chunk of process.stdin) { buf += chunk; break; }
    return buf.trim();
  };
  const ak = arg('--ak') || await ask('AK: ');
  const sk = arg('--sk') || await ask('SK: ');
  const endpoint = arg('--endpoint') || await ask(`endpoint [${DEFAULT_ENDPOINT}]: `) || DEFAULT_ENDPOINT;
  const bucket = arg('--bucket') || await ask('bucket: ');
  if (!ak || !sk || !bucket) {
    console.error('init 失败：AK/SK/bucket 均必填（--ak --sk --endpoint --bucket 或交互输入）');
    process.exit(2);
  }

  // 1) 写 obsutil config（600）
  const cfgPath = path.join(HOME, '.obsutilconfig');
  fs.writeFileSync(cfgPath, [
    `endpoint=${endpoint}`,
    `ak=${ak}`,
    `sk=${sk}`,
    'token=',
    'cname=false',
    `endpointCrr=http://your-endpoint`,
    `akCrr=*** Provide your Access Key ***`,
    `skCrr=*** Provide your Secret Key ***`,
    `tokenCrr=`,
    '',
  ].join('\n'), { mode: 0o600 });

  // 2) 写本技能 config 段（~/.fmode/config.json，不含密钥本体）
  const fmodeDir = path.join(HOME, '.fmode');
  const fmodeCfg = path.join(fmodeDir, 'config.json');
  fs.mkdirSync(fmodeDir, { recursive: true });
  let j = {};
  try { j = JSON.parse(fs.readFileSync(fmodeCfg, 'utf8')); } catch { /* 新文件 */ }
  j.obsBucket = bucket;
  j.obsEndpoint = endpoint;
  fs.writeFileSync(fmodeCfg, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  console.error(`已写入 ${cfgPath}（600）与 ${fmodeCfg}（技能 config 段，不含密钥本体）`);

  // 3) 立即 test：上传 1KB 探针 → 删除 → 报告
  return cmdTest();
}

/** test：上传 1KB 探针文件→删除→报告成功 */
async function cmdTest() {
  const cfg = await resolveStorageConfig();
  if (!cfg.ak && !cfg.sts) { printWizard(); process.exit(2); }
  if (!cfg.bucket) { console.error(`凭据已命中（${cfg.via}）但未解析到 bucket：请 --bucket 指定或用 init 写入`); process.exit(2); }
  const tmp = path.join(os.tmpdir(), `fmode-storage-probe-${process.pid}.txt`);
  fs.writeFileSync(tmp, 'fmode-storage probe ' + new Date().toISOString() + '\n');
  const key = `skill-storage-selftest/probe-${process.pid}.txt`;
  try {
    const up = runObsutil(cfg.obsUtilPath, ['cp', tmp, `obs://${cfg.bucket}/${key}`], { timeout: 120000 });
    if (!up.ok) { console.error('test 失败（上传）:', up.out.slice(-300)); process.exit(1); }
    const del = runObsutil(cfg.obsUtilPath, ['rm', `obs://${cfg.bucket}/${key}`, '-f'], { timeout: 60000 });
    if (!del.ok) { console.error('test 失败（清理探针文件，上传本身已成功）:', del.out.slice(-300)); process.exit(1); }
    console.log(JSON.stringify({ ok: true, bucket: cfg.bucket, endpoint: cfg.endpoint, via: cfg.via, probeKey: key, message: '上传 1KB 探针→删除 全部成功' }, null, 2));
    return true;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

// ============================================================================
// main
// ============================================================================

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
  const experimentalSts = rest.includes('--experimental-sts');
  if (rest.includes('--refresh-probe')) invalidateProbeCache();

  if (cmd === 'init') { process.exit(await cmdInit(rest) ? 0 : 1); }
  if (cmd === 'test') { process.exit(await cmdTest() ? 0 : 1); }

  const cfg = await resolveStorageConfig({ experimentalSts });
  if (!cfg.ak && !cfg.sts) {
    if (cmd !== 'help') {
      console.error('凭据链 4 级全部未命中（env → obsutil config → 平台签发(未上线) → 项目 config）。');
      printWizard();
      process.exit(2);
    }
  }
  if (cfg.ak && !cfg.sts && !cfg.bucket && ['put', 'setacl'].includes(cmd)) {
    console.error(`凭据已命中（${cfg.via}）但未解析到 bucket：用 --bucket 指定，或重新执行 init 写入完整配置。`);
    process.exit(2);
  }
  const obs = (args, timeout = 120000) => cfg.sts
    ? runWithSts(cfg.sts, args, timeout)
    : runObsutil(cfg.obsUtilPath, args, { timeout });

  if (cmd === 'put') {
    const file = rest[0];
    let key = arg('--key');
    if (!file || !key) { console.error('用法: put <file> --key <objectKey> [--acl public-read]'); process.exit(2); }
    const acl = arg('--acl') || 'public-read';
    const bucketArg = arg('--bucket'); if (bucketArg) cfg.bucket = bucketArg;
    const r = obs(['cp', file, `obs://${cfg.bucket}/${key}`, ...(acl ? ['-acl', acl] : [])]);
    if (!r.ok) { console.error('上传失败:', r.out.slice(-300)); process.exit(1); }
    console.log(JSON.stringify({ ok: true, key, url: publicUrl(cfg, key), bucket: cfg.bucket, via: cfg.via }, null, 2));
    return;
  }
  if (cmd === 'setacl') {
    const key = arg('--key'); const acl = arg('--acl') || 'public-read';
    const recursive = rest.includes('-r');
    const r = obs(['chattri', `obs://${cfg.bucket}/${key}`, '-acl', acl, ...(recursive ? ['-r', '-f'] : ['-f'])]);
    if (!r.ok) { console.error('setacl 失败:', r.out.slice(-300)); process.exit(1); }
    console.log(JSON.stringify({ ok: true }, null, 2));
    return;
  }
  if (cmd === 'config') {
    // 诊断输出：绝不包含 AK/SK/token/sessionToken 任何密钥本体
    console.log(JSON.stringify({
      via: cfg.via,
      bucket: cfg.bucket,
      endpoint: cfg.endpoint,
      cdnDomain: cfg.cdnDomain,
      credentialsResolved: Boolean(cfg.ak || cfg.sts),
      stsExperimental: Boolean(cfg.sts),
      stsPrefix: cfg.sts ? cfg.sts.prefix : null,
    }, null, 2));
    return;
  }
  console.log('用法: init | test | put | setacl | config');
}

main().catch((e) => { console.error('未预期错误:', e.message); process.exit(1); });
