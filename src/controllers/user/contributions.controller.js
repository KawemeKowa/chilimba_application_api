const { query } = require('../../config/db');
const { recordContribution } = require('../../services/chilimba.service');
const { paginate, paginatedResponse } = require('../../middleware/errorHandler');

// GET /api/groups/:groupId/contributions
const getGroupContributions = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { cycle, round } = req.query;
    const { limit, offset, page } = paginate(req);

    let whereExtra = '';
    const params = [groupId];
    if (cycle) { params.push(cycle); whereExtra += ` AND c.cycle_number = $${params.length}`; }
    if (round) { params.push(round); whereExtra += ` AND c.round_number = $${params.length}`; }

    const total = await query(
      `SELECT COUNT(*) FROM contributions c WHERE c.group_id = $1 ${whereExtra}`,
      params
    );
    params.push(limit, offset);
    const result = await query(
      `SELECT c.*, u.first_name, u.last_name
       FROM contributions c JOIN users u ON u.id = c.user_id
       WHERE c.group_id = $1 ${whereExtra}
       ORDER BY c.cycle_number, c.round_number, u.last_name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    paginatedResponse(res, result.rows, parseInt(total.rows[0].count), { page, limit });
  } catch (err) { next(err); }
};

// GET /api/contributions/my  (current user's contributions)
const getMyContributions = async (req, res, next) => {
  try {
    const { groupId, status } = req.query;
    const { limit, offset, page } = paginate(req);
    const params = [req.user.id];
    let whereExtra = '';

    if (groupId) { params.push(groupId); whereExtra += ` AND c.group_id = $${params.length}`; }
    if (status) { params.push(status); whereExtra += ` AND c.status = $${params.length}`; }

    const total = await query(
      `SELECT COUNT(*) FROM contributions c WHERE c.user_id = $1 ${whereExtra}`,
      params
    );
    params.push(limit, offset);
    const result = await query(
      `SELECT c.*, g.name AS group_name
       FROM contributions c JOIN groups g ON g.id = c.group_id
       WHERE c.user_id = $1 ${whereExtra}
       ORDER BY c.due_date DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    paginatedResponse(res, result.rows, parseInt(total.rows[0].count), { page, limit });
  } catch (err) { next(err); }
};

// GET /api/contributions/upcoming  — next dues for current user
const getUpcomingDues = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT c.*, g.name AS group_name, g.monthly_amount
       FROM contributions c JOIN groups g ON g.id = c.group_id
       WHERE c.user_id = $1 AND c.status = 'pending' AND c.due_date >= NOW()
       ORDER BY c.due_date ASC LIMIT 10`,
      [req.user.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// POST /api/contributions/:contributionId/pay
const payContribution = async (req, res, next) => {
  try {
    const { contributionId } = req.params;
    // Verify this contribution belongs to the user
    const check = await query(
      'SELECT id FROM contributions WHERE id = $1 AND user_id = $2',
      [contributionId, req.user.id]
    );
    if (!check.rows.length) {
      return res.status(404).json({ success: false, message: 'Contribution not found' });
    }

    const result = await recordContribution(contributionId, req.user.id, req.ip);
    res.json({
      success: true,
      message: 'Contribution recorded successfully',
      data: {
        reference: result.contribution.reference,
        amountPaid: result.contribution.amount_due,
        feeCharged: result.feeCharged,
        netAmount: result.netAmount,
      }
    });
  } catch (err) { next(err); }
};

module.exports = { getGroupContributions, getMyContributions, getUpcomingDues, payContribution };
