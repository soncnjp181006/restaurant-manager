import { CalendarDate } from '@internationalized/date';
import { DateValue } from 'react-aria-components';
import dayjs, { Dayjs } from "dayjs";
import {
  calendarDateToAppDateTime,
  nowInAppTimezone,
  toLuxonDateTime,
} from "@/lib/datetime.ts";

/**
 * Converts a Date / ISO string to a CalendarDate using the app timezone.
 */
export const dateToCalendarDate = (date: Date | string | undefined): CalendarDate | null => {
  if (!date) return null;

  const luxon = toLuxonDateTime(date);
  if (!luxon.isValid) return null;

  return new CalendarDate(luxon.year, luxon.month, luxon.day);
};

/**
 * Converts a CalendarDate (DateValue) to a JS Date at start of day in the app timezone.
 */
export const calendarDateToDate = (dateValue: DateValue | null | undefined): Date | null => {
  if (!dateValue) return null;

  return calendarDateToAppDateTime({
    year: dateValue.year,
    month: dateValue.month,
    day: dateValue.day,
  }).toJSDate();
};

/**
 * Gets today's date as a CalendarDate in the app timezone.
 */
export const getToday = (): CalendarDate => {
  const now = nowInAppTimezone();
  return new CalendarDate(now.year, now.month, now.day);
};

/**
 * Maps a CalendarDate to a dayjs at LOCAL midnight so antd renders exactly the
 * same Y/M/D regardless of the browser timezone. Never convert through a
 * timezone-qualified instant here: an app-tz midnight instant rendered in a
 * UTC browser shows the previous day (the original off-by-one bug).
 */
export const dateValueToDayjs = (dateValue: DateValue | null | undefined): Dayjs | null => {
  if (!dateValue) return null;

  return dayjs(new Date(dateValue.year, dateValue.month - 1, dateValue.day));
};

/**
 * Reads Y/M/D straight off the dayjs calendar — the exact inverse of
 * dateValueToDayjs, with no timezone math in either direction.
 */
export const dayjsToCalendarDate = (value: Dayjs | null | undefined): CalendarDate | null => {
  if (!value) return null;

  return new CalendarDate(value.year(), value.month() + 1, value.date());
};
