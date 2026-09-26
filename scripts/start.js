#!/usr/bin/env node

const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_PORT = Number(process.env.PORT || 17890);
const NODE_DOWNLOAD_URL = 'https://nodejs.org/zh-cn/download';

function openExternal(url) {
  if (process.env.PPTER_NO_OPEN === '1') return;
  let command;
  let args;
  if (process.platform === 'darwin') { command = 'open'; args = [url]; }
  else if (process.platform === 'win32') { command = 'cmd'; args = ['/c', 'start', '', url]; }
  else { command = 'xdg-open'; args = [url]; }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function nodeVersionSupported(version = process.versions.node) {
  return Number(String(version).split('.')[0]) >= 18;
}

function checkNodeVersion() {
  if (nodeVersionSupported()) return;
  console.error(`当前 Node.js 版本为 ${process.versions.node}，ppter ppt 需要 Node.js 18 或更高版本。`);
  console.error(`安装地址: ${NODE_DOWNLOAD_URL}`);
  openExternal(NODE_DOWNLOAD_URL);
  process.exit(1);
}

function dependenciesInstalled() {
  try {
    require.resolve('express', { paths: [ROOT_DIR] });
    require.resolve('fflate', { paths: [ROOT_DIR] });
    require.resolve('jspdf', { paths: [ROOT_DIR] });
    require.resolve('lucide-static', { paths: [ROOT_DIR] });
    return true;
  } catch {
    return false;
  }
}

function installDependencies() {
  if (dependenciesInstalled()) return;
  console.log('首次启动，正在安装必要组件，请保持网络连接...');
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, ['install', '--no-audit', '--no-fund'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw result.error || new Error('依赖安装失败，请检查网络后重新双击启动器');
  }
}

function portIsFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start) {
  for (let port = start; port <= start + 20; port++) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`端口 ${start}-${start + 20} 均被占用，请关闭其他 ppter ppt 窗口后重试`);
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.success === true && /^\d+\.\d+\.\d+/.test(String(data.version || ''));
  } catch {
    return false;
  }
}

async function waitForHealth(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await health(port)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('服务启动超时，请查看上方错误信息');
}

async function main() {
  checkNodeVersion();
  installDependencies();

  if (await health(DEFAULT_PORT)) {
    const url = `http://127.0.0.1:${DEFAULT_PORT}/`;
    console.log(`ppter ppt 已在运行，正在打开: ${url}`);
    openExternal(url);
    return;
  }

  const port = await findFreePort(DEFAULT_PORT);
  const url = `http://127.0.0.1:${port}/`;
  console.log('----------------------------------------');
  console.log('ppter ppt');
  console.log(`访问地址: ${url}`);
  console.log('关闭此窗口即可停止服务。');
  console.log('----------------------------------------');

  const child = spawn(process.execPath, [path.join(ROOT_DIR, 'server.js')], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'inherit',
  });
  const stop = signal => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  try {
    await waitForHealth(port);
    openExternal(url);
  } catch (error) {
    stop('SIGTERM');
    throw error;
  }

  child.on('exit', code => process.exit(code ?? 0));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`启动失败: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { dependenciesInstalled, findFreePort, health, nodeVersionSupported, portIsFree };
