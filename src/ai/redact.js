// What counts as a secret, for everything Tito reads before it is sent to an AI provider:
// tool text results (files, folder listings, errors) go through redactText(); screenshots go
// through bin/tito-redact with the same patterns (see native/redact.swift).
// Patterns are plain strings so the same list works in JavaScript and NSRegularExpression.
// When a pattern has a capture group, only group 1 is hidden (the value, not its label).
const SECRET_PATTERNS = [
  '\\b(?:sk|rk|pk)-[A-Za-z0-9_\\-]{16,}',                 // OpenAI / Anthropic / Stripe style
  '\\bgsk_[A-Za-z0-9]{20,}',                              // Groq
  '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}',          // GitHub tokens
  '\\bgithub_pat_[A-Za-z0-9_]{20,}',
  '\\bxox[baprs]-[A-Za-z0-9\\-]{10,}',                    // Slack
  '\\bAKIA[0-9A-Z]{16}\\b',                               // AWS access key id
  '\\bAIza[0-9A-Za-z_\\-]{30,}',                          // Google API key
  '\\beyJ[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}', // JWT
  '(?i)\\bbearer\\s+([A-Za-z0-9._\\-]{16,})',
  '(?i)(?:password|passwd|passphrase|secret|token|api[ _\\-]?key|access[ _\\-]?key)\\s*[:=]\\s*["\']?([^\\s"\']{6,})',
  '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  '\\b[A-Fa-f0-9]{40,}\\b',                               // long hex blobs
];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Patterns plus the user's own saved keys (matched exactly).
function patternsWith(secrets = []) {
  return [...secrets.filter(s => s && s.length >= 8).map(escapeRe), ...SECRET_PATTERNS];
}

function toRegExp(p) {
  const ci = p.startsWith('(?i)');
  return new RegExp(ci ? p.slice(4) : p, ci ? 'gi' : 'g');
}

function redactText(text, secrets = []) {
  let s = String(text == null ? '' : text);
  let count = 0;
  for (const p of patternsWith(secrets)) {
    s = s.replace(toRegExp(p), (m, g1) => {
      count++;
      return typeof g1 === 'string' && g1 ? m.replace(g1, '[redacted]') : '[redacted]';
    });
  }
  // A private key block: drop everything up to its END line too.
  s = s.replace(/\[redacted\][\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]');
  return { text: s, count };
}

module.exports = { SECRET_PATTERNS, patternsWith, redactText };
