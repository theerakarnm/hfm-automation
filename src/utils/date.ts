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

export function formatShortDate(dateString: string): string {
  const [year, month, day] = dateString.split("-");
  if (!year || !month || !day) return dateString;
  return `${day}/${month}/${year.slice(-2)}`;
}

function ictDateToUTC(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12));
}

function utcToIctDateString(utc: Date): string {
  return utc.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
}

function addDays(dateStr: string, days: number): string {
  const utc = ictDateToUTC(dateStr);
  utc.setUTCDate(utc.getUTCDate() + days);
  return utcToIctDateString(utc);
}

function getIctDayOfWeek(dateStr: string): number {
  const utc = ictDateToUTC(dateStr);
  const day = utc.getUTCDay();
  return day === 0 ? 6 : day - 1;
}

export interface WeekRange {
  from: string;
  to: string;
}

export function getThisWeekRange(now = new Date()): WeekRange {
  const today = getIctDateString(now);
  const dow = getIctDayOfWeek(today);
  const monday = addDays(today, -dow);
  return { from: monday, to: today };
}

export function getLastWeekRange(now = new Date()): WeekRange {
  const today = getIctDateString(now);
  const dow = getIctDayOfWeek(today);
  const lastSunday = addDays(today, -dow - 1);
  const lastMonday = addDays(lastSunday, -6);
  return { from: lastMonday, to: lastSunday };
}

export interface MonthRange {
  from: string;
  to: string;
}

export function getThisMonthRange(now = new Date()): MonthRange {
  const today = getIctDateString(now);
  const [y, m] = today.split("-");
  return { from: `${y}-${m}-01`, to: today };
}

export function getLastMonthRange(now = new Date()): MonthRange {
  const today = getIctDateString(now);
  const [yStr, mStr] = today.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  const prevFirst = `${prevY}-${String(prevM).padStart(2, "0")}-01`;
  const utcFirst = ictDateToUTC(prevFirst);
  utcFirst.setUTCMonth(utcFirst.getUTCMonth() + 1);
  utcFirst.setUTCDate(utcFirst.getUTCDate() - 1);
  const prevLast = utcToIctDateString(utcFirst);
  return { from: prevFirst, to: prevLast };
}
