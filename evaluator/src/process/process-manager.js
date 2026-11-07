import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const WINDOWS_SYSTEM_ENV = [
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'COMSPEC',
  'PATHEXT',
];

function buildChildEnv(values, allowedKeys) {
  const env = {};

  // Само необходимите системни променливи за Windows.
  if (process.platform === 'win32') {
    for (const key of WINDOWS_SYSTEM_ENV) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }
  }

  // Само изрично разрешените променливи за съответния процес.
  for (const key of allowedKeys) {
    if (values[key] !== undefined) {
      env[key] = String(values[key]);
    }
  }

  return env;
}

export function startNodeService({
  name,
  scriptPath,
  cwd,
  env,
  allowedEnv,
}) {
  if (!name || !scriptPath || !cwd) {
    throw new Error('Service name, scriptPath and cwd are required');
  }

  const absoluteScript = path.resolve(scriptPath);
  const absoluteCwd = path.resolve(cwd);

  const child = spawn(process.execPath, [absoluteScript], {
    cwd: absoluteCwd,
    env: buildChildEnv(env, allowedEnv),
    stdio: 'inherit',
    windowsHide: true,
  });

  const service = {
    name,
    child,
    exited: false,
    exitCode: null,
    signal: null,
  };

  child.once('error', (error) => {
    service.exited = true;
    service.error = error;
  });

  child.once('exit', (code, signal) => {
    service.exited = true;
    service.exitCode = code;
    service.signal = signal;
  });

  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(service));
    child.once('error', reject);
  });
}

function canConnect(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function waitForPort(
  service,
  port,
  { host = '127.0.0.1', timeoutMs = 15000 } = {},
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (service.exited) {
      throw new Error(
        `${service.name} exited before becoming ready`,
      );
    }

    if (await canConnect(port, host)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(
    `${service.name} did not listen on ${host}:${port} within ${timeoutMs}ms`,
  );
}

export async function stopNodeService(service, timeoutMs = 5000) {
  if (!service || service.exited || service.child.exitCode !== null) {
    return;
  }

  const child = service.child;

  const closed = new Promise((resolve) => {
    child.once('close', resolve);
  });

  child.kill('SIGTERM');

  const stoppedGracefully = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) =>
      setTimeout(() => resolve(false), timeoutMs),
    ),
  ]);

  if (!stoppedGracefully && child.exitCode === null) {
    child.kill('SIGKILL');
    await closed;
  }

  service.exited = true;
}