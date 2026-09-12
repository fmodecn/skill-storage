#!/usr/bin/env node
/**
 * fmode-storage uploader — 对象存储上传/公开链接/ACL
 * 零依赖（Node ≥18）。凭据按 5 级优先级自动解析，永不入库。
 *
 * 第0级（自举）：sessionToken → POST /api/storage/credentials 换 STS 临时凭证，
 *   内存持有直传 OBS（不落盘、不进日志）。后续级为回落链（自建 OBS / 已有
 *   obsutil config 的用户不受影响）。
 *
 * 用法:
 *   node uploader.mjs put <file> --key <objectKey> [--acl public-read] [--endpoint ...] [--bucket ...]
 *   node uploader.mjs setacl --key <prefix|key> --acl public-read [-r]
 *   node uploader.mjs config
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawnSync } from 'child_process';

const HOME = os.homedir();

// fmode 网关基址（签发 STS / 下载 URL）
const FMODE_API_BASE = process.env.FMODE_API_BASE || 'https://server.fmode.cn';
// 自举 v2（权威，2026-09 实测可用）：sessionToken + projectId → STS
// 见 fmode-studio rules/09 §4.3.4 与 future-server api/api-ncloud/apig/routes-deploy.js
const DEPLOY_STS_URL = `${FMODE_API_BASE.replace(/\/$/, '')}/api/apig/deploy/huaweicloud`;
// 自举 v1（历史设计，端点可能未部署；失败自动回落 v2）
const STORAGE_CREDENTIALS_URL = `${FMODE_API_BASE.replace(/\/$/, '')}/api/storage/credentials`;

/**
 * 解析 storage 专用 projectId（非密钥）。
 * 来源优先级：FMODE_STORAGE_PROJECT_ID 环境变量
 *   → ~/.fmode/config.json 的 storageProjectId
 *   → ~/.fmode/config/user.json 的 storageProjectId
 *   → ./.fmode/deploy.json 的 projectId（当前项目自己的发布身份）
 */
export function resolveStorageProjectId() {
  if (process.env.FMODE_STORAGE_PROJECT_ID) return process.env.FMODE_STORAGE_PROJECT_ID.trim();
  const candidates = [
    path.join(HOME, '.fmode', 'config.json'),
    path.join(HOME, '.fmode', 'config', 'user.json'),
    path.join(process.cwd(), '.fmode', 'deploy.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
      const id = j.storageProjectId || j.projectId || null;
      if (id && String(id).trim()) return String(id).trim();
    } catch { /* try next source */ }
  }
  return null;
}

/**
 * 第0级：解析 sessionToken。
 * 来源（优先级）：FMODE_SESSION_TOKEN 环境变量
 *   → ~/.fmode/config.json 的 sessionToken / user.sessionToken
 *   → ~/.fmode/config/user.json 的 sessionToken
 * 找到即返回字符串，找不到返回 null（不报错——交给上层决定是否回落）。
 */
export function resolveSessionToken() {
  if (process.env.FMODE_SESSION_TOKEN) return process.env.FMODE_SESSION_TOKEN.trim();
  // user.json 优先：登录流程（07-git「平台 sessionToken 失效恢复」）写入的最新 token
  const candidates = [
    path.join(HOME, '.fmode', 'config', 'user.json'),
    path.join(HOME, '.fmode', 'config.json'),
    path.join(process.cwd(), '.fmode', 'config.json'),
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
 * 第0级：sessionToken → STS 临时凭证（AK/SK/SecurityToken，作用域限定用户 prefix）。
 *
 * 权威链路（fmode-studio/docs/obs-cdn/02-架构与路径划分.md §5.2）：
 *   sessionToken → POST /api/storage/credentials
 *                → { accessKeyId, secretAccessKey, sessionToken(即 SecurityToken),
 *                    endpoint, bucket, prefix, expiration }
 *                → 客户端直传 OBS
 *
 * ⚠️ 返回的 STS 仅内存持有：不写文件、不打日志、不进错误信息。
 *
 * @returns {Promise<{ ak: string, sk: string, securityToken: string,
 *           endpoint: string, bucket: string, prefix: string } | null>}
 *          签发失败返回 null（调用方回落第1-4级）。
 */
export async function fetchStsCredentials(sessionToken) {
  if (!sessionToken) return null;
  try {
    const res = await fetch(STORAGE_CREDENTIALS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
      },
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
      endpoint: cred.endpoint || 'obs.cn-south-1.myhuaweicloud.com',
      bucket: cred.bucket || null,
      prefix: cred.prefix || '',
    };
  } catch { /* 网络/签名失败一律回落，不泄露错误细节 */ }
  return null;
}

/**
 * 自举 v2（权威链路）：sessionToken + projectId → POST /api/apig/deploy/huaweicloud → STS。
 * 服务端用平台自己的华为云授权签发项目隔离短时 STS，目标固定为
 *   obs://nova-cloud/dev/<projectId>/（bucket=nova-cloud, prefix=dev/<projectId>/）。
 * 返回字段映射：data.accessKey→ak, data.secretKey→sk, data.securityToken→securityToken,
 * data.obsPath→bucket/prefix 解析。成功返回对象，失败返回 null（调用方回落）。
 */
export async function fetchStsViaDeploy(sessionToken, projectId) {
  if (!sessionToken || !projectId) return null;
  try {
    const res = await fetch(DEPLOY_STS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sessionToken, projectId }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const data = body && body.data;
    if (!body || body.code !== 200 || !data || !data.success) return null;
    const obsPath = String(data.obsPath || '');           // 例: obs://nova-cloud/dev/<projectId>/
    const m = obsPath.match(/^obs:\/\/([^/]+)\/(.*)\/$/);
    return {
      ak: String(data.accessKey || ''),
      sk: String(data.secretKey || ''),
      securityToken: String(data.securityToken || ''),
      expiresAt: data.expiresAt || null,
      endpoint: 'obs.cn-south-1.myhuaweicloud.com',
      bucket: m ? m[1] : 'nova-cloud',
      prefix: m ? m[2] : '',
      projectId,
    };
  } catch { /* 网络失败一律回落，不泄露错误细节 */ }
  return null;
}

/**
 * 用 STS 临时凭证构造一次性 obsutil 配置目录，执行命令后即删。
 * 配置只写进临时目录（0700），命令结束立即删除——STS 不落盘留存、不进日志。
 *
 * @param {object} sts  fetchStsCredentials() 的返回值
 * @param {string[]} args obsutil 参数（不含 -e/-i/-k/-t）
 */
export function runWithSts(sts, args, timeout = 300000) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmode-sts-'));
  fs.chmodSync(tmpDir, 0o700);
  const cfgFile = path.join(tmpDir, '.obsutilconfig');
  // STS 写入临时配置仅供 obsutil 本次调用读取，结束后立刻删除
  fs.writeFileSync(cfgFile, [
    `endpoint=${sts.endpoint}`,
    `ak=${sts.ak}`,
    `sk=${sts.sk}`,
    `token=${sts.securityToken}`,
    '',
  ].join('\n'), { mode: 0o600 });
  try {
    const r = spawnSync('obsutil', args, {
      encoding: 'utf8',
      timeout,
      env: { ...process.env, OBSUTIL_CONFIG_FILE: cfgFile },
    });
    const out = (r.stdout || '') + (r.stderr || '');
    return { ok: /Upload successfully|Download successfully|Set the acl/i.test(out) || r.status === 0, out };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** 5 级凭据/配置解析：第0级 sessionToken 自举 → env → ~/.fmode → ./.fmode → obsutil 默认链 */
export async function resolveStorageConfig() {
  const cfg = {
    obsUtilPath: 'obsutil',
    endpoint: 'obs.cn-south-1.myhuaweicloud.com',
    bucket: null,
    cdnDomain: null,
    sts: null,       // 第0级自举得到的 STS（内存持有）
    via: null,       // 命中的解析级别（诊断用，不含任何密钥）
  };
  // ---- 第0级自举 v2（权威）：sessionToken + projectId → deploy/huaweicloud → STS ----
  const sessionToken = resolveSessionToken();
  if (sessionToken) {
    const projectId = resolveStorageProjectId();
    if (projectId) {
      const sts = await fetchStsViaDeploy(sessionToken, projectId);
      if (sts) {
        cfg.sts = sts;
        cfg.bucket = sts.bucket || cfg.bucket;
        cfg.endpoint = sts.endpoint || cfg.endpoint;
        cfg.cdnDomain = process.env.FMODE_CDN_DOMAIN || 'app.fmode.cn';
        cfg.via = 'level0v2:sessionToken+projectId->deploySTS';
        return cfg; // 自举成功，无需回落
      }
    }
    // v2 未命中（无 projectId 或签发失败）→ v1 历史端点
    const sts1 = await fetchStsCredentials(sessionToken);
    if (sts1) {
      cfg.sts = sts1;
      cfg.bucket = sts1.bucket || cfg.bucket;
      cfg.endpoint = sts1.endpoint || cfg.endpoint;
      cfg.via = 'level0v1:sessionToken->STS';
      return cfg;
    }
    // sessionToken 存在但两条链路都失败：给出明确报错指向重新登录
    console.error('sessionToken 存在但 STS 换取失败（v2 deploy 与 v1 credentials 均未命中）——sessionToken 失效或缺少 storageProjectId 配置');
    console.error('（将继续尝试第1-4级回落配置）');
  }
  // ---- 第1级：环境变量 ----
  if (process.env.FMODE_OBS_CONF) {
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(process.env.FMODE_OBS_CONF, 'utf8'))); cfg.via = 'level1:FMODE_OBS_CONF'; } catch {}
  }
  // ---- 第2/3级：~/.fmode/config.json → ./.fmode/config.json ----
  for (const p of [path.join(HOME, '.fmode', 'config.json'), path.join(process.cwd(), '.fmode', 'config.json')]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.obsUtilPath) cfg.obsUtilPath = j.obsUtilPath;
      if (j.obsBucket) { cfg.bucket = j.obsBucket; cfg.via = cfg.via || `level:${p}`; }
      if (j.obsEndpoint) cfg.endpoint = j.obsEndpoint;
      if (j.cdnDomain) cfg.cdnDomain = j.cdnDomain;
    } catch {}
  }
  // ---- 第4级：obsutil 默认链（已配置则探测 bucket）----
  if (!cfg.bucket) {
    try {
      const out = execSync(`${cfg.obsUtilPath} ls -limit=1 2>/dev/null`, { encoding: 'utf8', timeout: 15000 });
      const m = out.match(/obs:\/\/([^/]+)/);
      if (m) { cfg.bucket = m[1]; cfg.via = 'level4:obsutil-default'; }
    } catch {}
  }
  return cfg;
}

/** 公开 URL: cdnDomain 优先, 否则桶域名 */
export function publicUrl(cfg, key) {
  if (cfg.cdnDomain) return `https://${cfg.cdnDomain}/${key}`;
  return `https://${cfg.bucket}.${cfg.endpoint}/${key}`.replace('.myhuaweicloud.com', '.myhuaweicloud.com');
}

/** v2 STS 的 key 必须限定在签发的 prefix 内（dev/<projectId>/...），防止越权路径 */
function scopedKey(cfg, key) {
  if (cfg.sts && cfg.sts.prefix) {
    const pfx = cfg.sts.prefix.endsWith('/') ? cfg.sts.prefix : cfg.sts.prefix + '/';
    if (key.startsWith(pfx)) return key;
    return pfx + key.replace(/^\/+/, '');
  }
  return key;
}

function obs(args, cfg, timeout = 120000) {
  // 第0级命中 → STS 一次性临时配置执行（不落盘留存）
  if (cfg.sts) return runWithSts(cfg.sts, args, timeout);
  // 回落：用户自己的 obsutil 配置
  const r = spawnSync(cfg.obsUtilPath, [...args, '-e', cfg.endpoint], { encoding: 'utf8', timeout });
  const out = (r.stdout || '') + (r.stderr || '');
  return { ok: /Upload successfully|Download successfully|Set the acl/i.test(out) || r.status === 0, out };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfg = await resolveStorageConfig();
  if (!cfg.bucket && cmd !== 'help') {
    console.error('未解析到 bucket：请登录 FMODE Studio（sessionToken 自举）或配置 ~/.fmode/config.json 的 obsBucket/obsEndpoint 或 obsutil config。');
    console.error('（技能绝不内置密钥；自建 OBS 用户用 obsutil config 自行配置）');
    process.exit(2);
  }
  const arg = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };

  if (cmd === 'put') {
    const file = rest[0];
    let key = arg('--key');
    if (!file || !key) { console.error('用法: put <file> --key <objectKey> [--acl public-read]'); process.exit(2); }
    const acl = arg('--acl') || 'public-read';
    const bucketArg = arg('--bucket'); if (bucketArg) cfg.bucket = bucketArg;
    key = scopedKey(cfg, key); // v2 STS: 强制限定 dev/<projectId>/ 前缀
    const r = obs(['cp', file, `obs://${cfg.bucket}/${key}`], cfg);
    if (!r.ok) { console.error('上传失败:', r.out.slice(-300)); process.exit(1); }
    console.log(JSON.stringify({ ok: true, key, url: publicUrl(cfg, key), bucket: cfg.bucket, via: cfg.via }, null, 2));
    return;
  }
  if (cmd === 'setacl') {
    const key = arg('--key'); const acl = arg('--acl') || 'public-read';
    const recursive = rest.includes('-r');
    const r = obs(['chattri', `obs://${cfg.bucket}/${key}`, '-acl', acl, ...(recursive ? ['-r', '-f'] : ['-f'])], cfg);
    console.log(JSON.stringify({ ok: r.ok }, null, 2));
    return;
  }
  if (cmd === 'config') {
    // 诊断输出：绝不包含 AK/SK/SecurityToken/sessionToken 任何密钥本体
    console.log(JSON.stringify({
      via: cfg.via,
      bucket: cfg.bucket,
      endpoint: cfg.endpoint,
      cdnDomain: cfg.cdnDomain,
      stsBootstrapped: Boolean(cfg.sts),
      stsPrefix: cfg.sts ? cfg.sts.prefix : null,
      stsProjectId: cfg.sts && cfg.sts.projectId ? cfg.sts.projectId : null,
      stsExpiresAt: cfg.sts && cfg.sts.expiresAt ? cfg.sts.expiresAt : null,
    }, null, 2));
    return;
  }
  console.log('用法: put | setacl | config');
}

main();
