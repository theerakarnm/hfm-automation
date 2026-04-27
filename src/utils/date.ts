export function getIctDateString(date = new Date()): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
}

export function getPreviousIctDateString(date = new Date()): string {
  const ictDate = getIctDateString(date);
  const [yearText, monthText, dayText] = ictDate.split("-");
  if (!yearText || !monthText || !dayText) {
    throw new Error(`Invalid ICT date string: ${ictDate}`);
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const utcNoon = new Date(Date.UTC(year, month - 1, day, 12));
  utcNoon.setUTCDate(utcNoon.getUTCDate() - 1);
  return utcNoon.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
}

export function formatIctDisplayDate(dateString: string): string {
  const [year, month, day] = dateString.split("-");
  if (!year || !month || !day) {
    throw new Error(`Invalid date string: ${dateString}`);
  }
  return `${day}/${month}/${year}`;
}
