const express = require('express');
const { body, param } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const adminCtrl = require('../controllers/admin/admin.controller');
const superCtrl = require('../controllers/superadmin/superadmin.controller');

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(authenticate, requireRole('admin', 'super_admin'));

// Users
adminRouter.get('/users', adminCtrl.listUsers);
adminRouter.get('/users/:userId', adminCtrl.getUserDetail);
adminRouter.patch('/users/:userId/status', [
  body('status').isIn(['active', 'suspended', 'banned']),
  body('reason').optional().trim(),
], adminCtrl.updateUserStatus);
adminRouter.post('/users/:userId/verify', adminCtrl.verifyUser);

// Groups
adminRouter.get('/groups', adminCtrl.listGroups);
adminRouter.patch('/groups/:groupId/status', [
  body('status').isIn(['active', 'paused', 'completed', 'dissolved']),
], adminCtrl.updateGroupStatus);

// Payouts
adminRouter.get('/payouts/pending', adminCtrl.getPendingPayouts);
adminRouter.post('/payouts/:payoutScheduleId/disburse', adminCtrl.processPayoutDisbursement);

// Withdrawals
adminRouter.get('/withdrawals', adminCtrl.listWithdrawals);

// Fees
adminRouter.get('/fees', adminCtrl.getFees);
adminRouter.patch('/fees/:feeId', [
  body('value').optional().isFloat({ min: 0 }),
  body('isActive').optional().isBoolean(),
], adminCtrl.updateFee);

// Broadcast
adminRouter.post('/notifications/broadcast', [
  body('title').trim().notEmpty(),
  body('body').trim().notEmpty(),
  body('targetRole').optional().isIn(['member', 'group_admin', 'admin']),
], adminCtrl.broadcastNotification);

// ─── SUPER ADMIN ROUTES ───────────────────────────────────────────────────────
const superAdminRouter = express.Router();
superAdminRouter.use(authenticate, requireRole('super_admin'));

// Analytics
superAdminRouter.get('/analytics/overview', superCtrl.getPlatformOverview);
superAdminRouter.get('/analytics/daily', superCtrl.getDailyStats);
superAdminRouter.get('/analytics/groups', superCtrl.getGroupStats);
superAdminRouter.get('/analytics/compliance', superCtrl.getMemberCompliance);
superAdminRouter.get('/analytics/revenue', superCtrl.getRevenueBreakdown);
superAdminRouter.get('/analytics/top-groups', superCtrl.getTopGroups);
superAdminRouter.get('/analytics/user-growth', superCtrl.getUserGrowth);

// Platform settings
superAdminRouter.get('/settings', superCtrl.getSettings);
superAdminRouter.patch('/settings/:key', [
  body('value').notEmpty(),
], superCtrl.updateSetting);

// Audit
superAdminRouter.get('/audit-logs', superCtrl.getAuditLogs);

// Health
superAdminRouter.get('/health', superCtrl.getHealthCheck);

// Finance / Lipila
superAdminRouter.get('/finance', superCtrl.getFinanceOverview);

// Admin management
superAdminRouter.get('/admins', superCtrl.listAdmins);
superAdminRouter.patch('/admins/:userId/role', [
  body('role').isIn(['member', 'admin', 'super_admin']),
], superCtrl.updateUserRole);

module.exports = { adminRouter, superAdminRouter };
