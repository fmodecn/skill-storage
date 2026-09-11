#!/usr/bin/env node
#!/usr/bin/env node
/**
 * fmode-storage uploader — 对象存储上传/公开链接/ACL
 * 零依赖（Node ≥18）。凭据按 4 级优先级自动解析，永不入库。
 *
 * 用法:
 *   node uploader.mjs put <file> --key <objectKey> [--acl public-read] [--endpoint ...] [--bucket ...]
 *   node uploader.mjs setacl --key <prefix|key> --acl public-read [-r]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawnSync } from 'child_process';

const HOME = os.homedir();

/** 4 级凭据/配置解析: env → ~/.fmode/config.json → ./.fmode/config.json → obsutil 默认链 */
export function resolveStorageConfig() {
  const cfg = { obsUtilPath: 'obsutil', endpoint: 'obs.cn-south-1.myhuaweicloud.com', bucket: null, cdnDomain: null };
  // 1) 环境变量
  if (process.env.FMODE_OBS_CONF) {
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(process.env.FMODE_OBS_CONF, 'utf8'))); } catch {}
  }
  // 2) ~/.fmode/config.json
  for (const p of [path.join(HOME, '.fmode', 'config.json'), path.join(process.cwd(), '.fmode', 'config.json')]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.obsUtilPath) cfg.obsUtilPath = j.obsUtilPath;
      if (j.obsBucket) cfg.bucket = j.obsBucket;
      if (j.obsEndpoint) cfg.endpoint = j.obsEndpoint;
      if (j.cdnDomain) cfg.cdnDomain = j.cdnDomain;
    } catch {}
  }
  if (!cfg.bucket) {
    // 3) obsutil 默认链: 若 obsutil 已配置, 从其 log/配置探测 bucket
    try {
      const out = execSync(`${cfg.obsUtilPath} ls -limit=1 2>/dev/null`, { encoding: 'utf8', timeout: 15000 });
      const m = out.match(/obs:\/\/([^/]+)/);
      if (m) cfg.bucket = m[1];
    } catch {}
  }
  return cfg;
}

/** 公开 URL: cdnDomain 优先, 否则桶域名 */
export function publicUrl(cfg, key) {
  if (cfg.cdnDomain) return `https://${cfg.cdnDomain}/${key}`;
  return `https://${cfg.bucket}.${cfg.endpoint}/${key}`.replace('.myhuaweicloud.com', '.myhuaweicloud.com');
}

function obs(args, cfg, timeout = 120000) {
  const r = spawnSync(cfg.obsUtilPath, [...args, '-e', cfg.endpoint], { encoding: 'utf8', timeout });
  const out = (r.stdout || '') + (r.stderr || '');
  return { ok: /Upload successfully|Download successfully|Set the acl/i.test(out) || r.status === 0, out };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfg = resolveStorageConfig();
  if (!cfg.bucket && cmd !== 'help') {
    console.error('未解析到 bucket：请配置 ~/.fmode/config.json 的 obsBucket/obsEndpoint 或 obsutil config。');
    console.error('（技能绝不内置密钥；AK/SK 用 obsutil config 自行配置）');
    process.exit(2);
  }
  const arg = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };

  if (cmd === 'put') {
    const file = rest[0];
    let key = arg('--key');
    if (!file || !key) { console.error('用法: put <file> --key <objectKey> [--acl public-read]'); process.exit(2); }
    const acl = arg('--acl') || 'public-read';
    const bucketArg = arg('--bucket'); if (bucketArg) cfg.bucket = bucketArg;
    const r = obs(['cp', file, `obs://${cfg.bucket}/${key}`], cfg);
    if (!r.ok) { console.error('上传失败:', r.out.slice(-300)); process.exit(1); }
    console.log(JSON.stringify({ ok: true, key, url: publicUrl(cfg, key), bucket: cfg.bucket }, null, 2));
    return;
  }
  if (cmd === 'setacl') {
    const key = arg('--key'); const acl = arg('--acl') || 'public-read';
    const recursive = rest.includes('-r');
    const r = obs(['chattri', `obs://${cfg.bucket}/${key}`, '-acl', acl, ...(recursive ? ['-r', '-f'] : ['-f'])], cfg);
    console.log(JSON.stringify({ ok: r.ok }, null, 2));
    return;
  }
  if (cmd === 'config') { console.log(JSON.stringify({ ...cfg }, null, 2)); return; }
  console.log('用法: put | setacl | config');
}

main();
