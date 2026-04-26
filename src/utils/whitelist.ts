export function isWhitelisted(userId: string): boolean {
  const raw = process.env.LINE_WHITELIST_UIDS?.trim() ?? "";
  if (raw === "") return true;

  const allowed = raw
    .split(",")
    .map((uid) => uid.trim())
    .filter((uid) => uid.length > 0);

  return allowed.includes(userId);
}
