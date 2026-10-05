export const PAYMENT_METHODS = ['cash', 'bank', 'cheque', 'online'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['posted', 'void', 'bounced'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** What reduces an invoice's outstanding amount (CLAUDE.md 8.5). */
export const ALLOCATION_SOURCES = ['payment', 'sales_return', 'write_off'] as const;
export type AllocationSource = (typeof ALLOCATION_SOURCES)[number];
