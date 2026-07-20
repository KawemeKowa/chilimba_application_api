// ─── USER AUTH ROUTES ─────────────────────────────────────────────────────────
const express = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validate');
const { uploadPhoto } = require('../middleware/upload');

// ── auth.routes.js ──
const authRouter = express.Router();
const authCtrl = require('../controllers/user/auth.controller');
const { authenticate } = require('../middleware/auth');

authRouter.post('/register', uploadPhoto, [
  body('firstName').trim().notEmpty(),
  body('lastName').trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('phone').trim().notEmpty(),
  body('password').isLength({ min: 8 }),
  body('dateOfBirth').optional().isDate(),
], authCtrl.register);

authRouter.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], authCtrl.login);

authRouter.post('/refresh', body('refreshToken').notEmpty(), authCtrl.refreshToken);
authRouter.post('/logout', authCtrl.logout);
authRouter.get('/me', authenticate, authCtrl.getMe);
authRouter.patch('/me', authenticate, uploadPhoto, [
  body('firstName').optional().trim().notEmpty(),
  body('lastName').optional().trim().notEmpty(),
  body('phone').optional().trim().notEmpty(),
], authCtrl.updateProfile);
authRouter.post('/change-password', authenticate, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8 }),
], authCtrl.changePassword);

authRouter.post('/forgot-password', [
  body('email').isEmail().normalizeEmail(),
], validate, authCtrl.forgotPassword);

authRouter.post('/reset-password/:token', [
  body('password').isLength({ min: 8 }),
], validate, authCtrl.resetPassword);

// ── groups.routes.js ──
const groupsRouter = express.Router();
const groupsCtrl = require('../controllers/user/groups.controller');
const { requireGroupMember, requireGroupAdmin } = require('../middleware/rbac');

groupsRouter.post('/', authenticate, uploadPhoto, [
  body('name').trim().notEmpty().isLength({ max: 150 }),
  body('monthlyAmount').isFloat({ min: 1 }),
  body('maxMembers').optional().isInt({ min: 2, max: 5000 }),
  body('contributionDay').optional().isInt({ min: 1, max: 28 }),
  body('payoutDay').optional().isInt({ min: 1, max: 28 }),
  body('currency').optional().isIn(['ZMW', 'USD', 'EUR', 'GBP', 'ZAR']),
], groupsCtrl.createGroup);

groupsRouter.post('/join', authenticate, [
  body('inviteCode').trim().notEmpty().isLength({ min: 8, max: 8 }),
], groupsCtrl.joinGroup);

groupsRouter.get('/', authenticate, groupsCtrl.getMyGroups);

groupsRouter.get('/:groupId', authenticate, requireGroupMember, groupsCtrl.getGroupDetail);

groupsRouter.patch('/:groupId', authenticate, requireGroupAdmin, uploadPhoto, groupsCtrl.updateGroup);

groupsRouter.post('/:groupId/rotate-invite', authenticate, requireGroupAdmin, groupsCtrl.rotateInviteCode);

groupsRouter.get('/:groupId/payout-schedule', authenticate, requireGroupMember, groupsCtrl.getPayoutSchedule);

groupsRouter.delete('/:groupId/members/:userId', authenticate, requireGroupAdmin, groupsCtrl.removeMember);

// Email invitations — static paths must come before /:groupId
groupsRouter.get('/invitations/:token', groupsCtrl.getInvitation);
groupsRouter.post('/invitations/:token/accept', authenticate, groupsCtrl.acceptInvitation);
groupsRouter.post('/invitations/:token/decline', groupsCtrl.declineInvitation);

groupsRouter.post('/:groupId/invite', authenticate, requireGroupAdmin, [
  body('email').isEmail().normalizeEmail(),
], validate, groupsCtrl.inviteMember);

// Payout order management + group-level disbursement (approver permission)
const payoutsCtrl = require('../controllers/user/payouts.controller');
groupsRouter.get('/:groupId/payout-order', authenticate, requireGroupMember, payoutsCtrl.getPayoutOrder);
groupsRouter.post('/:groupId/payout-order', authenticate, requireGroupMember, payoutsCtrl.proposePayoutOrder);
groupsRouter.post('/:groupId/payout-order/:proposalId/vote', authenticate, requireGroupMember, [
  body('action').isIn(['approved', 'rejected']),
], validate, payoutsCtrl.voteOnProposal);
groupsRouter.post('/:groupId/members/:userId/permissions', authenticate, requireGroupAdmin, [
  body('permission').equals('approver'),
  body('grant').isBoolean(),
], validate, payoutsCtrl.setMemberPermission);
groupsRouter.post('/:groupId/payouts/:payoutScheduleId/disburse', authenticate, requireGroupMember, payoutsCtrl.disburseGroupPayout);

// ── contributions.routes.js ──
const contribRouter = express.Router();
const contribCtrl = require('../controllers/user/contributions.controller');

contribRouter.get('/my', authenticate, contribCtrl.getMyContributions);
contribRouter.get('/upcoming', authenticate, contribCtrl.getUpcomingDues);
contribRouter.post('/:contributionId/pay', authenticate, contribCtrl.payContribution);
contribRouter.get('/group/:groupId', authenticate, requireGroupMember, contribCtrl.getGroupContributions);

// ── withdrawals.routes.js ──
const withdrawalsRouter = express.Router();
const withdrawalsCtrl = require('../controllers/user/withdrawals.controller');

withdrawalsRouter.post('/groups/:groupId', authenticate, requireGroupMember, [
  body('amount').isFloat({ min: 0.01 }),
  body('reason').trim().notEmpty(),
], withdrawalsCtrl.createWithdrawalRequest);

withdrawalsRouter.get('/groups/:groupId', authenticate, requireGroupMember, withdrawalsCtrl.getGroupWithdrawals);

withdrawalsRouter.post('/:withdrawalId/vote', authenticate, [
  body('action').isIn(['approved', 'rejected']),
  body('comment').optional().trim(),
], withdrawalsCtrl.voteOnWithdrawal);

// ── committee.routes.js ──
const committeeRouter = express.Router();
const committeeCtrl = require('../controllers/user/committee.controller');

committeeRouter.post('/groups/:groupId', authenticate, requireGroupMember, [
  body('title').trim().notEmpty(),
  body('description').trim().notEmpty(),
  body('category').isIn(['funeral', 'wedding', 'emergency', 'other']),
  body('targetAmount').optional().isFloat({ min: 0 }),
], committeeCtrl.createCommitteePool);

committeeRouter.get('/groups/:groupId', authenticate, requireGroupMember, committeeCtrl.getCommitteePools);

committeeRouter.post('/:poolId/contribute', authenticate, [
  body('amount').isFloat({ min: 0.01 }),
  body('isAnonymous').optional().isBoolean(),
], committeeCtrl.contributeToPool);

committeeRouter.get('/:poolId/contributors', authenticate, committeeCtrl.getContributors);

committeeRouter.patch('/:poolId/close', authenticate, committeeCtrl.closePool);

// ── payments.routes.js ──
const paymentsRouter = express.Router();
const paymentsCtrl = require('../controllers/user/payments.controller');

paymentsRouter.post('/deposit', authenticate, [
  body('walletId').optional().isUUID(),
  body('groupId').optional().isUUID(),
  body('amount').isFloat({ min: 1 }),
  body('method').optional().isIn(['mobile_money', 'card']),
  body('mobileNumber').optional().trim(),
], validate, paymentsCtrl.initiateDeposit);

paymentsRouter.get('/methods',              authenticate, paymentsCtrl.getPaymentMethods);
paymentsRouter.put('/methods/mobile-money', authenticate, [
  body('mobileNumber').trim().notEmpty(),
  body('provider').isIn(['mtn', 'airtel', 'zamtel']),
], validate, paymentsCtrl.saveMobileMoney);
paymentsRouter.put('/methods/bank', authenticate, [
  body('bankName').trim().notEmpty(),
  body('accountNumber').trim().notEmpty(),
  body('accountName').trim().notEmpty(),
  body('swiftCode').optional().trim(),
], validate, paymentsCtrl.saveBankDetails);
paymentsRouter.get('/history', authenticate, paymentsCtrl.getPaymentHistory);
paymentsRouter.post('/sync-status', authenticate, [
  body('referenceId').trim().notEmpty(),
], validate, paymentsCtrl.syncTransactionStatus);

// ── webhooks (public — no auth) ──
const webhooksRouter = express.Router();
webhooksRouter.post('/lipila', paymentsCtrl.handleWebhook);

// ── misc.routes.js (messages, wallet, notifications) ──
const miscRouter = express.Router();
const miscCtrl = require('../controllers/user/misc.controller');

// Messages
miscRouter.post('/groups/:groupId/messages', authenticate, requireGroupMember, [
  body('content').trim().notEmpty().isLength({ max: 2000 }),
  body('parentId').optional().isUUID(),
], miscCtrl.postMessage);

miscRouter.get('/groups/:groupId/messages', authenticate, requireGroupMember, miscCtrl.getMessages);
miscRouter.delete('/messages/:messageId', authenticate, miscCtrl.deleteMessage);

// Wallet
miscRouter.get('/wallet', authenticate, miscCtrl.getWallet);
miscRouter.get('/wallet/transactions', authenticate, miscCtrl.getTransactions);

// Notifications
miscRouter.get('/notifications', authenticate, miscCtrl.getNotifications);
miscRouter.patch('/notifications/read-all', authenticate, miscCtrl.markAllRead);
miscRouter.patch('/notifications/:id/read', authenticate, miscCtrl.markRead);

module.exports = { authRouter, groupsRouter, contribRouter, withdrawalsRouter, committeeRouter, miscRouter, paymentsRouter, webhooksRouter };
