import {LaborDateRangeFilter} from '@/components/reports/filters/labor.date.range.filter.tsx';
import {REPORTS_LABOR_DAILY_COST} from '@/routes/restaurant-manager.ts';

export const LaborDailyCostFilter = () => <LaborDateRangeFilter action={REPORTS_LABOR_DAILY_COST} includeBranchScope />;
