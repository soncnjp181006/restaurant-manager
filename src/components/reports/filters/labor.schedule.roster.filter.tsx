import {LaborDateRangeFilter} from '@/components/reports/filters/labor.date.range.filter.tsx';
import {REPORTS_LABOR_SCHEDULE_ROSTER} from '@/routes/restaurant-manager.ts';

export const LaborScheduleRosterFilter = () => <LaborDateRangeFilter action={REPORTS_LABOR_SCHEDULE_ROSTER} />;
