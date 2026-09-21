import path from 'node:path';

// A policy looks at what an agent produced and returns a reason string if it's not allowed.
// Violations are fatal: no retry, the workflow safe-stops.

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /(password|secret|api[_-]?key|token)\s*[:=]\s*["'][^"']{8,}["']/i,
];

export const noSecrets = {
  id: 'security/no-secrets',
  check(output) {
    const text = JSON.stringify(output ?? {}).replace(/\\"/g, '"');
    return SECRET_PATTERNS.some((p) => p.test(text)) ? 'output looks like it contains a credential' : null;
  },
};

// Agents may only write inside the run's output folder.
export const writeScope = {
  id: 'change-control/write-scope',
  check(output, _stage, context) {
    const root = path.resolve(context.outDir);
    for (const file of output?.writes ?? []) {
      const resolved = path.resolve(file);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) return `write outside allowed folder: ${file}`;
    }
    return null;
  },
};

export const defaultPolicies = [noSecrets, writeScope];
