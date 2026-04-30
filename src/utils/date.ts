import { dayjs, ICT_TIME_ZONE } from "./dayjs";

export function getIctDateString(date = new Date()): string {
  return dayjs(date).tz(ICT_TIME_ZONE).format("YYYY-MM-DD");
}

export function getPreviousIctDateString(date = new Date()): string {
  return dayjs(date).tz(ICT_TIME_ZONE).subtract(1, "day").format("YYYY-MM-DD");
}

export function formatIctDisplayDate(dateString: string): string {
  const d = dayjs(dateString, "YYYY-MM-DD", true);
  if (!d.isValid()) {
    throw new Error(`Invalid date string: ${dateString}`);
  }
  return d.format("DD/MM/YYYY");
}

export function formatShortDate(dateString: string): string {
  const d = dayjs(dateString, "YYYY-MM-DD", true);
  if (!d.isValid()) return dateString;
  return d.format("DD/MM/YY");
}

export interface WeekRange {
  from: string;
  to: string;
}

export function getThisWeekRange(now = new Date()): WeekRange {
  const today = dayjs(now).tz(ICT_TIME_ZONE);
  const daysSinceMonday = (today.day() + 6) % 7;
  const monday = today.subtract(daysSinceMonday, "day");
  return {
    from: monday.format("YYYY-MM-DD"),
    to: today.format("YYYY-MM-DD"),
  };
}

export function getLastWeekRange(now = new Date()): WeekRange {
  const today = dayjs(now).tz(ICT_TIME_ZONE);
  const daysSinceMonday = (today.day() + 6) % 7;
  const lastSunday = today.subtract(daysSinceMonday + 1, "day");
  const lastMonday = lastSunday.subtract(6, "day");
  return {
    from: lastMonday.format("YYYY-MM-DD"),
    to: lastSunday.format("YYYY-MM-DD"),
  };
}

export interface MonthRange {
  from: string;
  to: string;
}

export function getThisMonthRange(now = new Date()): MonthRange {
  const today = dayjs(now).tz(ICT_TIME_ZONE);
  return {
    from: today.startOf("month").format("YYYY-MM-DD"),
    to: today.format("YYYY-MM-DD"),
  };
}

export function getLastMonthRange(now = new Date()): MonthRange {
  const today = dayjs(now).tz(ICT_TIME_ZONE);
  const lastMonth = today.subtract(1, "month");
  return {
    from: lastMonth.startOf("month").format("YYYY-MM-DD"),
    to: lastMonth.endOf("month").format("YYYY-MM-DD"),
  };
}
