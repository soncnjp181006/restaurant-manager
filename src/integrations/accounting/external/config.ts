import { LogicalAccountCode } from '@/integrations/accounting/types.ts';
import { ExternalAccountingConfig } from '@/integrations/accounting/external/types.ts';

const ACCOUNT_KEYS: LogicalAccountCode[] = [
  'SALES_REVENUE',
  'VAT_OUTPUT',
  'DISCOUNT',
  'CASH_MAIN',
  'CARD_RECEIVABLE',
  'OTHER_RECEIVABLE',
  'INVENTORY',
  'COGS',
  'PAYROLL_EXPENSE',
  'PAYROLL_LIABILITY',
  'ACCOUNTS_PAYABLE',
  'WASTE_EXPENSE',
  'INVENTORY_ADJUSTMENT',
];

/** giá trị cũ đã lưu trong DB, chỉ dùng khi đọc — ghi xuống luôn dùng tên mới */
const LEGACY_SYNC_DIRECTION_VALUES: Record<string, ExternalAccountingConfig['syncDirection']> = {
  posr_to_external: 'local_to_external',
};

export const parseExternalAccountingConfig = (raw: Record<string, unknown>): ExternalAccountingConfig => {
  const accounts: Record<LogicalAccountCode, string> = {} as Record<LogicalAccountCode, string>;

  for (const key of ACCOUNT_KEYS) {
    const value = raw[key] ?? raw[`account_${key}`];
    if (typeof value === 'string' && value.trim()) {
      accounts[key] = value.trim();
    }
  }

  const paymentMappings: Record<string, string> = {};
  const rawPaymentMappings = raw.paymentMappings;
  if (typeof rawPaymentMappings === 'object' && rawPaymentMappings !== null) {
    for (const [k, v] of Object.entries(rawPaymentMappings as Record<string, unknown>)) {
      if (typeof v === 'string') paymentMappings[k] = v;
    }
  }

  const paymentAccountMappings: Record<string, string> = {};
  const rawPaymentAcctMap = raw.paymentAccountMappings;
  if (typeof rawPaymentAcctMap === 'object' && rawPaymentAcctMap !== null) {
    for (const [k, v] of Object.entries(rawPaymentAcctMap as Record<string, unknown>)) {
      if (typeof v === 'string') paymentAccountMappings[k] = v;
    }
  }

  const syncDirection = (raw.syncDirection ?? 'local_to_external') as ExternalAccountingConfig['syncDirection'];

  return {
    tenantId: String(raw.tenantId ?? raw.realmId ?? ''),
    syncDirection: LEGACY_SYNC_DIRECTION_VALUES[syncDirection] ?? syncDirection,
    syncIntervalMinutes: Number(raw.syncIntervalMinutes ?? raw.syncInterval ?? 60),
    saleDocumentType: (raw.saleDocumentType as ExternalAccountingConfig['saleDocumentType']) ?? 'sales_receipt',
    enableClasses: Boolean(raw.enableClasses),
    enableDepartments: Boolean(raw.enableDepartments),
    enableInventoryJournals: Boolean(raw.enableInventoryJournals ?? true),
    defaultCustomerId: typeof raw.defaultCustomerId === 'string' ? raw.defaultCustomerId : undefined,
    defaultRevenueAccount: typeof raw.defaultRevenueAccount === 'string' ? raw.defaultRevenueAccount : undefined,
    defaultTaxAccount: typeof raw.defaultTaxAccount === 'string' ? raw.defaultTaxAccount : undefined,
    defaultInventoryAccount: typeof raw.defaultInventoryAccount === 'string' ? raw.defaultInventoryAccount : undefined,
    defaultExpenseAccount: typeof raw.defaultExpenseAccount === 'string' ? raw.defaultExpenseAccount : undefined,
    accounts,
    paymentMappings,
    paymentAccountMappings,
  };
};

export const validateExternalAccountMapping = (
  mapping: Record<LogicalAccountCode, string>
): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];
  const required: LogicalAccountCode[] = [
    'SALES_REVENUE',
    'CASH_MAIN',
    'CARD_RECEIVABLE',
    'INVENTORY',
    'COGS',
  ];
  for (const code of required) {
    if (!mapping[code]) {
      errors.push(`Missing external account mapping for ${code}`);
    }
  }
  return { valid: errors.length === 0, errors };
};
