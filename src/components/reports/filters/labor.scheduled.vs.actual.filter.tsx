import {LaborDateRangeFilter} from '@/components/reports/filters/labor.date.range.filter.tsx';
import {REPORTS_LABOR_SCHEDULED_VS_ACTUAL} from '@/routes/restaurant-manager.ts';

export const LaborScheduledVsActualFilter = () => <LaborDateRangeFilter action={REPORTS_LABOR_SCHEDULED_VS_ACTUAL} />;
