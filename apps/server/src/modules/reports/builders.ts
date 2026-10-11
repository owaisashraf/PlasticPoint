import type { ReportBuilder } from './engine';
import { customerActivity, customerAging, customerSummary, itemsBought, paymentBehaviour } from './customer-reports';
import {
  assetRegister,
  cashBankBook,
  depreciationScheduleReport,
  discountReport,
  expenseReport,
  grossProfit,
  netProfit,
  profitCheck,
  profitLoss,
  stockValuationReport,
} from './financial-reports';
import { dayBook, moneyBook, priceList, salesByItem, stockOnHand } from './operational-reports';

/** Report key (see REPORTS in the shared package) → the function that builds it. */
export const BUILDERS: Record<string, ReportBuilder> = {
  'customer-summary': customerSummary,
  'customer-aging': customerAging,
  'payment-behaviour': paymentBehaviour,
  'items-bought': itemsBought,
  'customer-activity': customerActivity,
  'day-book': dayBook,
  'money-book': moneyBook,
  'sales-by-item': salesByItem,
  'stock-on-hand': stockOnHand,
  'price-list': priceList,
  'profit-loss': profitLoss,
  'net-profit': netProfit,
  'gross-profit': grossProfit,
  'discount-report': discountReport,
  'profit-check': profitCheck,
  'expense-report': expenseReport,
  'asset-register': assetRegister,
  'depreciation-schedule': depreciationScheduleReport,
  'cash-bank-book': cashBankBook,
  'stock-valuation': stockValuationReport,
};
