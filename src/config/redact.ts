const REDACTED = '[REDACTED]';
const sensitiveKeys = new Set(['apikey', 'authorization', 'token', 'accesstoken', 'refreshtoken', 'secret', 'password']);
const isSensitiveKey = (key: string) => sensitiveKeys.has(key.toLowerCase().replace(/[-_]/g, ''));

/** Collect literal credential values, including unused nested project rules. */
export function sensitiveValues(value: unknown): string[] {
  const secrets = new Set<string>();
  const ordinaryVisited = new WeakSet<object>();
  const sensitiveVisited = new WeakSet<object>();
  const walk = (item: unknown, sensitive = false) => {
    if (typeof item === 'string') { if (sensitive && item) secrets.add(item); return; }
    const visited = sensitive ? sensitiveVisited : ordinaryVisited;
    if (!item || typeof item !== 'object' || visited.has(item)) return;
    visited.add(item);
    for (const [key, child] of Object.entries(item)) walk(child, sensitive || isSensitiveKey(key));
  };
  walk(value);
  return [...secrets];
}

/** Return a detached display/log copy; never modify trusted configuration or routing data. */
export function redactSensitive(value: unknown, knownSecrets: Iterable<string> = []): unknown {
  const secrets = [...new Set([...knownSecrets, ...sensitiveValues(value)].filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  const text = (input: string) => secrets.reduce((result, secret) => result.split(secret).join(REDACTED), input);
  const ancestors = new WeakSet<object>();
  const clone = (item: unknown): unknown => {
    if (typeof item === 'string') return text(item);
    if (!item || typeof item !== 'object') return item;
    if (ancestors.has(item)) return '[Circular]';
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.map(clone);
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [
        text(key), isSensitiveKey(key) ? REDACTED : clone(child),
      ]));
    } finally { ancestors.delete(item); }
  };
  return clone(value);
}
