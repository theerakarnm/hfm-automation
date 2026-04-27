function isWhitelistEnabled(): boolean {
  const raw = process.env.LINE_WHITELIST_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !["false", "0", "off", "no"].includes(raw);
}

export function isWhitelisted(userId: string): boolean {
  if (!isWhitelistEnabled()) return true;

  const raw = process.env.LINE_WHITELIST_UIDS?.trim() ?? "";
  if (raw === "") return true;

  const allowed = raw
    .split(",")
    .map((uid) => uid.trim())
    .filter((uid) => uid.length > 0);

  return allowed.includes(userId);
}
