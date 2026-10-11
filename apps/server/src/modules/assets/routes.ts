import { assetListQuerySchema, createAssetSchema, disposeAssetSchema, idParamSchema, updateAssetSchema, voidSchema } from '@shopledger/shared';
import type { AppInstance } from '../../app';
import { currentUser, requirePermission } from '../../lib/permissions';
import { createAsset, disposeAsset, getAsset, listAssets, updateAsset, voidAsset } from './service';

/** The asset register: owner and superuser only (assets.manage). */
export async function assetRoutes(app: AppInstance) {
  const { ctx } = app;
  const manage = requirePermission('assets.manage');

  app.get('/api/assets', { ...manage, schema: { querystring: assetListQuerySchema } }, async (req) => listAssets(ctx.dbh.db, req.query));
  app.get('/api/assets/:id', { ...manage, schema: { params: idParamSchema } }, async (req) => ({ asset: getAsset(ctx.dbh.db, req.params.id) }));
  app.post('/api/assets', { ...manage, schema: { body: createAssetSchema } }, async (req) => ({ asset: createAsset(ctx.dbh.db, currentUser(req), req.body) }));
  app.put('/api/assets/:id', { ...manage, schema: { params: idParamSchema, body: updateAssetSchema } }, async (req) => ({
    asset: updateAsset(ctx.dbh.db, currentUser(req), req.params.id, req.body),
  }));
  app.post('/api/assets/:id/dispose', { ...manage, schema: { params: idParamSchema, body: disposeAssetSchema } }, async (req) => ({
    asset: disposeAsset(ctx.dbh.db, currentUser(req), req.params.id, req.body),
  }));
  app.post('/api/assets/:id/void', { ...requirePermission('documents.edit_any'), schema: { params: idParamSchema, body: voidSchema } }, async (req) => ({
    asset: voidAsset(ctx.dbh.db, currentUser(req), req.params.id, req.body.reason),
  }));
}
