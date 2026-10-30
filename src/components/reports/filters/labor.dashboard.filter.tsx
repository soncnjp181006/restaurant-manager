import {LaborDateRangeFilter} from '@/components/reports/filters/labor.date.range.filter.tsx';
import {REPORTS_LABOR_DASHBOARD} from '@/routes/restaurant-manager.ts';

export const LaborDashboardFilter = () => <LaborDateRangeFilter action={REPORTS_LABOR_DASHBOARD} includeBranchScope />;
