#!/usr/bin/env node

var MIN_NODE_MAJOR = 20;
var MIN_NPM_MAJOR = 10;
var childProcess = require('node:child_process');

function parseMajor(versionString) {
  var match = String(versionString || '').match(/^v?(\d+)/);
  return match ? Number(match[1]) : NaN;
}

function parseNpmVersionFromUserAgent(userAgent) {
  var match = String(userAgent || '').match(/\bnpm\/(\d+(?:\.\d+){0,2})\b/);
  return match ? match[1] : '';
}

function buildErrorMessage(nodeVersion, npmVersion, errors) {
  var lines = [
    '',
    '❌ Unsupported runtime detected for Huey frontend tooling.',
    '',
    'Required runtime baseline:',
    '  - Node.js >= ' + MIN_NODE_MAJOR,
    '  - npm >= ' + MIN_NPM_MAJOR,
    '',
    'Current runtime:',
    '  - Node.js: ' + (nodeVersion || 'unknown'),
    '  - npm: ' + (npmVersion || 'unknown'),
    '',
    'Problems:',
  ];

  errors.forEach(function (error) {
    lines.push('  - ' + error);
  });

  lines.push(
    '',
    'Suggested fix:',
    '  1) nvm install 20',
    '  2) nvm use 20',
    '  3) npm ci',
    ''
  );

  return lines.join('\n');
}

function validateRuntime() {
  var nodeVersion = process.env.HUEY_NODE_VERSION_OVERRIDE || process.version;
  var npmUserAgent = process.env.HUEY_NPM_USER_AGENT_OVERRIDE || process.env.npm_config_user_agent || '';
  var npmVersion = parseNpmVersionFromUserAgent(npmUserAgent);
  if (!npmVersion) {
    try {
      npmVersion = String(childProcess.execSync('npm --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    } catch (_error) {
      npmVersion = '';
    }
  }

  var nodeMajor = parseMajor(nodeVersion);
  var npmMajor = parseMajor(npmVersion);
  var errors = [];

  if (!(nodeMajor >= MIN_NODE_MAJOR)) {
    errors.push('Node.js ' + MIN_NODE_MAJOR + '+ is required, but detected ' + (nodeVersion || 'unknown') + '.');
  }

  if (!npmVersion) {
    errors.push('npm version could not be detected. Run commands via npm and use npm ' + MIN_NPM_MAJOR + '+.');
  } else if (!(npmMajor >= MIN_NPM_MAJOR)) {
    errors.push('npm ' + MIN_NPM_MAJOR + '+ is required, but detected ' + npmVersion + '.');
  }

  return {
    ok: errors.length === 0,
    message: buildErrorMessage(nodeVersion, npmVersion, errors),
  };
}

if (require.main === module) {
  var result = validateRuntime();
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
}

module.exports = {
  validateRuntime: validateRuntime,
  parseMajor: parseMajor,
  parseNpmVersionFromUserAgent: parseNpmVersionFromUserAgent,
};
