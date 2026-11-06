import type {DateRangeFilter, DbClient} from '@/api/reports/shared/types.ts';
import {formatDateTimeForQuery} from '@/api/reports/shared/filters.ts';
import {getSalesSummary} from '@/api/reports/sales';
import {
  aggregateDailyLaborCost,
  aggregateTotalLaborCost,
  buildLaborReportContext,
} from '@/api/reports/labor/aggregate.ts';
import {
  fetchActiveBreakCount,
  fetchEmployees,
  fetchLaborAdjustments,
  fetchLaborPayRules,
  fetchPendingApprovalCount,
  fetchPublicHolidays,
  fetchScheduledShifts,
  fetchTimeEntries,
  fetchPayProfiles,
} from '@/api/reports/labor/fetch.ts';
import type {LaborDashboardSnapshot} from '@/api/reports/labor/shared/types.ts';
import type {Employee} from '@/api/model/employee.ts';
import type {EmployeePayProfile} from '@/api/model/employee_pay_profile.ts';
import type {PublicHoliday} from '@/api/model/public_holiday.ts';
import type {ScheduledShift} from '@/api/model/scheduled_shift.ts';
import type {TimeEntry} from '@/api/model/time_entry.ts';
import type {LaborAdjustment} from '@/api/model/labor_adjustment.ts';
import type {LaborPayRule} from '@/api/model/labor_pay_rule.ts';
import {recordToString} from '@/api/reports/shared/records.ts';
import {toLuxonDateTime, getAppTimezone} from '@/lib/datetime.ts';
import {safeNumber} from '@/lib/utils.ts';
import {DateTime} from 'luxon';

export const getLaborDashboardSnapshot = async (
  db: DbClient,
  options: Pick<DateRangeFilter, 'branchIds'> = {},
): Promise<LaborDashboardSnapshot> => {
  const now = DateTime.now().setZone(getAppTimezone());
  // Report date filters (buildCreatedAtDateConditions) already interpret these
  // strings as local wall-clock time in the app timezone and convert to UTC
  // internally — pass local boundaries directly, matching the `DateRange`
  // filter UI's convention, rather than pre-converting to UTC here.
  const startDate = formatDateTimeForQuery(now.startOf('day'));
  const endDate = formatDateTimeForQuery(now.endOf('day'));
  const {branchIds} = options;

  // One failing fetch used to reject the whole snapshot (all 14 KPI cards fell
  // back to zero). Settle each independently and degrade per-fetch instead.
  const settle = async <T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      console.error(`[labor-dashboard] ${label} failed`, error);
      failures.push(label);
      return fallback;
    }
  };
  const failures: string[] = [];

  const [
    employees,
    todayEntries,
    activeEntries,
    scheduledToday,
    payProfiles,
    holidays,
    adjustments,
    rules,
    onBreakCount,
    pendingApprovals,
    sales,
  ] = await Promise.all([
    settle('employees', () => fetchEmployees(db, {activeOnly: true}), [] as Employee[]),
    settle('timeEntries', () => fetchTimeEntries(db, {startDate, endDate, branchIds, includeOpen: true}), [] as TimeEntry[]),
    settle('activeEntries', () => fetchTimeEntries(db, {activeOnly: true, branchIds, includeOpen: true}), [] as TimeEntry[]),
    settle('scheduledShifts', () => fetchScheduledShifts(db, {startDate, endDate}), [] as ScheduledShift[]),
    settle('payProfiles', () => fetchPayProfiles(db, {startDate, endDate}), [] as EmployeePayProfile[]),
    settle('holidays', () => fetchPublicHolidays(db, {startDate, endDate}), [] as PublicHoliday[]),
    settle('adjustments', () => fetchLaborAdjustments(db, {startDate, endDate}), [] as LaborAdjustment[]),
    settle('payRules', () => fetchLaborPayRules(db), [] as LaborPayRule[]),
    settle('activeBreaks', () => fetchActiveBreakCount(db), 0),
    settle('pendingApprovals', () => fetchPendingApprovalCount(db), 0),
    settle('salesSummary', () => getSalesSummary(db, {startDate, endDate, branchIds}), {} as Awaited<ReturnType<typeof getSalesSummary>>),
  ]);

  const context = buildLaborReportContext({
    employees,
    timeEntries: todayEntries,
    payProfiles,
    holidays,
    adjustments,
    rules,
    periodStart: startDate,
    periodEnd: endDate,
  });

  const totals = aggregateTotalLaborCost(context);
  const netSales = safeNumber(sales.totalNetSales);

  const workedEmployeeDates = new Set(
    todayEntries.map(entry => {
      const empId = recordToString(entry.employee?.id ?? entry.employee);
      const date = toLuxonDateTime(entry.clock_in).toFormat('yyyy-MM-dd');
      return `${empId}|${date}`;
    }),
  );

  let missingCount = 0;
  let lateTodayCount = 0;
  let scheduledRemainingHours = 0;

  for (const shift of scheduledToday) {
    const empId = recordToString(shift.employee?.id ?? shift.employee);
    const date = toLuxonDateTime(shift.start_at).toFormat('yyyy-MM-dd');
    if (!workedEmployeeDates.has(`${empId}|${date}`) && toLuxonDateTime(shift.end_at) < now) {
      missingCount += 1;
    }

    const shiftEnd = toLuxonDateTime(shift.end_at);
    if (shiftEnd > now) {
      scheduledRemainingHours += Math.max(0, shiftEnd.diff(now, 'hours').hours);
    }
  }

  for (const entry of todayEntries) {
    if (safeNumber(entry.late_minutes) > 0) {
      lateTodayCount += 1;
    }
  }

  const avgHourlyCost = totals.totalHours > 0 ? totals.totalCost / totals.totalHours : 0;
  const projectedRemainingCost = scheduledRemainingHours * avgHourlyCost;
  const projectedEodCost = safeNumber(totals.totalCost + projectedRemainingCost);
  const overtimeHoursToday = totals.overtimeHours + totals.doubleTimeHours;

  return {
    asOf: now.toISO() ?? now.toFormat('yyyy-MM-dd HH:mm'),
    degraded: failures,
    clockedInCount: activeEntries.length,
    onBreakCount,
    scheduledTodayCount: scheduledToday.length,
    missingCount,
    lateTodayCount,
    currentLaborCost: totals.totalCost,
    projectedEodCost,
    laborCostToday: totals.totalCost,
    salesToday: netSales,
    laborPercent: netSales > 0 ? safeNumber((totals.totalCost / netSales) * 100) : 0,
    salesPerLaborHour: totals.totalHours > 0 ? safeNumber(netSales / totals.totalHours) : 0,
    overtimeHoursToday,
    pendingApprovals,
    activeHeadcount: employees.length,
    avgHourlyCost: safeNumber(avgHourlyCost),
  };
};

export const getLaborDashboardTrend = async (
  db: DbClient,
  options: Pick<DateRangeFilter, 'branchIds'> = {},
) => {
  const now = DateTime.now().setZone(getAppTimezone());
  // Same convention as getLaborDashboardSnapshot: pass local wall-clock
  // boundaries; buildCreatedAtDateConditions converts them to UTC. Calling
  // .toUTC() here would double-convert and shift the window by the zone offset.
  const startDate = formatDateTimeForQuery(now.minus({days: 13}).startOf('day'));
  const endDate = formatDateTimeForQuery(now.endOf('day'));
  const {branchIds} = options;
  const employees = await fetchEmployees(db, {activeOnly: true});
  const timeEntries = await fetchTimeEntries(db, {startDate, endDate, branchIds, includeOpen: true});
  const payProfiles = await fetchPayProfiles(db, {startDate, endDate});
  const holidays = await fetchPublicHolidays(db, {startDate, endDate});
  const adjustments = await fetchLaborAdjustments(db, {startDate, endDate});
  const rules = await fetchLaborPayRules(db);
  const context = buildLaborReportContext({
    employees,
    timeEntries,
    payProfiles,
    holidays,
    adjustments,
    rules,
    periodStart: startDate,
    periodEnd: endDate,
  });
  return aggregateDailyLaborCost(context);
};
