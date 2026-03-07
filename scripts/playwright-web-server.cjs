const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = process.cwd();
const logPath = path.resolve(rootDir, process.env.PLAYWRIGHT_WEB_SERVER_LOG_PATH || 'playwright-results/webserver.log');

fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, '');

const logStream = fs.createWriteStream(logPath, { flags: 'a' });

function writeLogLine(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  logStream.write(line);
}

function pipeOutput(streamName, chunk) {
  const text = chunk.toString();
  if (streamName === 'stderr') {
    process.stderr.write(text);
  } else {
    process.stdout.write(text);
  }
  logStream.write(text);
}

function spawnLoggedProcess(command, args) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: process.env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    pipeOutput('stdout', chunk);
  });
  child.stderr.on('data', (chunk) => {
    pipeOutput('stderr', chunk);
  });

  return child;
}

function waitForExit(child, description) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${description} exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`));
    });
  });
}

async function buildApp() {
  writeLogLine('Building app bundle for Playwright preview server.');
  const buildProcess = spawnLoggedProcess('npm', ['run', 'build']);
  await waitForExit(buildProcess, 'npm run build');
}

async function main() {
  await buildApp();
  writeLogLine('Starting Playwright preview server on http://127.0.0.1:8765.');

  const previewProcess = spawnLoggedProcess('npm', [
    'run',
    'preview',
    '--',
    '--host',
    '127.0.0.1',
    '--port',
    '8765',
    '--strictPort',
  ]);

  const forwardSignal = (signal) => {
    if (!previewProcess.killed) {
      previewProcess.kill(signal);
    }
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  previewProcess.once('error', (error) => {
    writeLogLine(`Preview server failed to start: ${error.stack || error}`);
    process.exit(1);
  });

  previewProcess.once('exit', (code, signal) => {
    writeLogLine(`Preview server exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}.`);
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  writeLogLine(`Failed to prepare Playwright web server: ${error.stack || error}`);
  process.exit(1);
});
