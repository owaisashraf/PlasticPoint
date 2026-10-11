import {
  createExpenseCategorySchema,
  createExpenseSchema,
  expenseListQuerySchema,
  idParamSchema,
  updateExpenseCategorySchema,
  updateExpenseSchema,
  voidSchema,
} from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { currentUser, requirePermission } from '../../lib/permissions';
import { createCategory, createExpense, deleteCategory, getExpense, listCategories, listExpenses, updateCategory, updateExpense, voidExpense } from './service';

/** Expenses and their categories: owner and superuser only (expenses.manage). */
export async function expenseRoutes(app: AppInstance) {
  const { ctx } = app;
  const manage = requirePermission('expenses.manage');

  app.get('/api/expense-categories', { ...manage }, async () => ({ categories: listCategories(ctx.dbh.db) }));
  app.post('/api/expense-categories', { ...manage, schema: { body: createExpenseCategorySchema } }, async (req) => ({
    category: createCategory(ctx.dbh.db, currentUser(req), req.body),
  }));
  app.patch('/api/expense-categories/:id', { ...manage, schema: { params: idParamSchema, body: updateExpenseCategorySchema } }, async (req) => ({
    category: updateCategory(ctx.dbh.db, currentUser(req), req.params.id, req.body),
  }));
  app.delete('/api/expense-categories/:id', { ...manage, schema: { params: idParamSchema } }, async (req) => {
    deleteCategory(ctx.dbh.db, currentUser(req), req.params.id);
    return { ok: true };
  });

  app.get('/api/expenses', { ...manage, schema: { querystring: expenseListQuerySchema } }, async (req) => listExpenses(ctx.dbh.db, req.query));
  app.get('/api/expenses/:id', { ...manage, schema: { params: idParamSchema } }, async (req) => ({ expense: getExpense(ctx.dbh.db, req.params.id) }));
  app.post('/api/expenses', { ...manage, schema: { body: createExpenseSchema } }, async (req) => ({ expense: createExpense(ctx.dbh.db, currentUser(req), req.body) }));
  app.put('/api/expenses/:id', { ...manage, schema: { params: idParamSchema, body: updateExpenseSchema } }, async (req) => ({
    expense: updateExpense(ctx.dbh.db, currentUser(req), req.params.id, req.body),
  }));
  app.post('/api/expenses/:id/void', { ...requirePermission('documents.edit_any'), schema: { params: idParamSchema, body: voidSchema } }, async (req) => ({
    expense: voidExpense(ctx.dbh.db, currentUser(req), req.params.id, req.body.reason),
  }));
}
