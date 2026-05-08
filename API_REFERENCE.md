# Chilimba API Reference

**Base URL:** `http://localhost:3000/api`
**Auth:** Bearer JWT in `Authorization` header
**Content-Type:** `application/json`

---

## Authentication (`/api/auth`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/register` | ❌ | Register new user (≥16 yrs) |
| POST | `/auth/login` | ❌ | Login → access + refresh tokens |
| POST | `/auth/refresh` | ❌ | Rotate refresh token |
| POST | `/auth/logout` | ❌ | Revoke refresh token |
| GET | `/auth/me` | ✅ | Get current user profile |
| PATCH | `/auth/me` | ✅ | Update profile |
| POST | `/auth/change-password` | ✅ | Change password |

### Register
```json
POST /auth/register
{
  "firstName": "Bwalya",
  "lastName": "Mwale",
  "email": "bwalya@example.com",
  "phone": "+260976543210",
  "password": "Secure@123",
  "dateOfBirth": "1995-06-15"
}
```

### Login
```json
POST /auth/login
{ "email": "bwalya@example.com", "password": "Secure@123" }

Response:
{
  "success": true,
  "data": {
    "user": { "id": "...", "firstName": "Bwalya", "role": "member" },
    "accessToken": "<jwt>",
    "refreshToken": "<token>"
  }
}
```

---

## Groups (`/api/groups`)

| Method | Endpoint | Auth | Role | Description |
|--------|----------|------|------|-------------|
| POST | `/groups` | ✅ | Member | Create a new Chilimba group |
| POST | `/groups/join` | ✅ | Member | Join via invite code |
| GET | `/groups` | ✅ | Member | My groups list |
| GET | `/groups/:groupId` | ✅ | Group Member | Group detail + members |
| PATCH | `/groups/:groupId` | ✅ | Group Admin | Update group settings |
| POST | `/groups/:groupId/rotate-invite` | ✅ | Group Admin | Regenerate invite code |
| GET | `/groups/:groupId/payout-schedule` | ✅ | Group Member | Full rotation schedule |
| DELETE | `/groups/:groupId/members/:userId` | ✅ | Group Admin | Remove a member |

### Create Group
```json
POST /groups
{
  "name": "Lusaka North Chilimba",
  "description": "Family savings group",
  "monthlyAmount": 500,
  "maxMembers": 12,
  "contributionDay": 1,
  "payoutDay": 25,
  "minApprovalsWithdrawal": 3,
  "currency": "ZMW"
}
```

### Payout Schedule Response
```json
[
  {
    "cycleNumber": 1,
    "payoutOrder": 1,
    "scheduledDate": "2025-06-25",
    "expectedAmount": 6000,
    "status": "scheduled",
    "firstName": "Bwalya",
    "lastName": "Mwale"
  }
]
```

---

## Contributions (`/api/contributions`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/contributions/my` | ✅ | My contribution history |
| GET | `/contributions/upcoming` | ✅ | Upcoming dues |
| POST | `/contributions/:id/pay` | ✅ | Mark contribution as paid |
| GET | `/contributions/group/:groupId` | ✅ | Group contributions list |

### Query Params (GET /contributions/my)
- `groupId` – filter by group
- `status` – `pending | paid | late | waived`
- `page`, `limit`

### Pay Contribution
```json
POST /contributions/b1c2d3e4-1234.../pay
→ {}

Response:
{
  "success": true,
  "data": {
    "reference": "CHI-B1C2D3E4-1-1-...",
    "amountPaid": 500,
    "feeCharged": 2.50,
    "netAmount": 497.50
  }
}
```

---

## Withdrawals (`/api/withdrawals`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/withdrawals/groups/:groupId` | ✅ | Request a group withdrawal |
| GET | `/withdrawals/groups/:groupId` | ✅ | List withdrawal requests |
| POST | `/withdrawals/:withdrawalId/vote` | ✅ | Approve or reject |

### Withdrawal Request
```json
POST /withdrawals/groups/:groupId
{
  "amount": 1500,
  "reason": "Emergency repair for the group meeting hall"
}
```

### Vote
```json
POST /withdrawals/:withdrawalId/vote
{
  "action": "approved",
  "comment": "Valid reason, approved."
}
```

**Lifecycle:**
`pending_approval` → (enough approvals) → `approved` → `processing` → `completed`
`pending_approval` → (enough rejections) → `rejected`
`pending_approval` → (72h timeout) → expires (enforced by admin)

---

## Committee Pools (`/api/committees`)

Voluntary crowdfunding campaigns within a group.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/committees/groups/:groupId` | ✅ | Create campaign |
| GET | `/committees/groups/:groupId` | ✅ | List campaigns |
| POST | `/committees/:poolId/contribute` | ✅ | Contribute to campaign |
| GET | `/committees/:poolId/contributors` | ✅ | List contributors |
| PATCH | `/committees/:poolId/close` | ✅ | Close campaign |

### Create Pool
```json
POST /committees/groups/:groupId
{
  "title": "Funeral support for Mama Banda",
  "description": "Contribute to support the Banda family",
  "category": "funeral",
  "targetAmount": 10000,
  "closesAt": "2025-07-15T23:59:00Z",
  "beneficiary": "Banda Family"
}
```

### Contribute
```json
POST /committees/:poolId/contribute
{
  "amount": 200,
  "message": "Sending love and support",
  "isAnonymous": false
}
```

---

## Group Messages (`/api/groups/:groupId/messages`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/groups/:groupId/messages` | ✅ | Post a message |
| GET | `/groups/:groupId/messages` | ✅ | Get message board |
| DELETE | `/messages/:messageId` | ✅ | Delete own message |

### Post Message (with reply)
```json
POST /groups/:groupId/messages
{
  "content": "Don't forget contributions are due on the 1st!",
  "parentId": null
}
```

---

## Wallet (`/api/wallet`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/wallet` | ✅ | My wallets (personal + group) |
| GET | `/wallet/transactions` | ✅ | Transaction history |

### Transaction History Query Params
- `walletId` – specific wallet
- `type` – `contribution | payout | withdrawal | fee | ...`
- `startDate`, `endDate`
- `page`, `limit`

---

## Notifications (`/api/notifications`)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/notifications` | ✅ | My notifications |
| PATCH | `/notifications/read-all` | ✅ | Mark all read |
| PATCH | `/notifications/:id/read` | ✅ | Mark one read |

### Query Params
- `unreadOnly=true` – unread only

---

---

# Admin API (`/api/admin`)

> **Required Role:** `admin` or `super_admin`

## User Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/users` | List all users |
| GET | `/admin/users/:userId` | User detail + groups |
| PATCH | `/admin/users/:userId/status` | Suspend / ban user |
| POST | `/admin/users/:userId/verify` | KYC verify & activate |

### Query Params (GET /admin/users)
- `status` – `active | pending_verification | suspended | banned`
- `role` – `member | admin | super_admin`
- `search` – name / email / phone

### Update Status
```json
PATCH /admin/users/:userId/status
{ "status": "suspended", "reason": "Fraudulent activity reported" }
```

---

## Group Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/groups` | List all groups |
| PATCH | `/admin/groups/:groupId/status` | Change group status |

---

## Payout Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/payouts/pending` | Payouts due for disbursement |
| POST | `/admin/payouts/:id/disburse` | Trigger payout to member |

---

## Withdrawal Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/withdrawals` | All withdrawal requests |

---

## Fee Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/admin/fees` | List fee configs |
| PATCH | `/admin/fees/:feeId` | Update fee value/status |

```json
PATCH /admin/fees/:feeId
{ "value": 0.75, "isActive": true }
```

---

## Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/admin/notifications/broadcast` | Broadcast to all users |

```json
POST /admin/notifications/broadcast
{
  "title": "Platform Maintenance",
  "body": "Chilimba will be down for maintenance on Sunday 2–4 AM.",
  "targetRole": "member"
}
```

---

---

# Super Admin API (`/api/superadmin`)

> **Required Role:** `super_admin`

## Analytics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/superadmin/analytics/overview` | Full platform snapshot |
| GET | `/superadmin/analytics/daily?days=30` | Daily transaction stats |
| GET | `/superadmin/analytics/groups` | Per-group financial summary |
| GET | `/superadmin/analytics/compliance` | Member contribution compliance rates |
| GET | `/superadmin/analytics/revenue?groupBy=month&months=12` | Revenue breakdown |
| GET | `/superadmin/analytics/top-groups` | Top 20 groups by volume |
| GET | `/superadmin/analytics/user-growth` | Monthly user registration trend |

### Overview Response
```json
{
  "users": {
    "total": 1200,
    "active": 980,
    "pending_verification": 180,
    "registered_today": 12,
    "registered_last_7d": 67
  },
  "groups": {
    "total": 145,
    "active": 130,
    "avg_monthly_amount": 650
  },
  "transactions": {
    "total_volume": "4500000.00",
    "fee_revenue": "45000.00",
    "txns_today": 42
  },
  "wallets": {
    "total_balance_on_platform": "820000.00"
  }
}
```

---

## Platform Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/superadmin/settings` | All platform settings |
| PATCH | `/superadmin/settings/:key` | Update a setting |

### Available Settings Keys
| Key | Default | Description |
|-----|---------|-------------|
| `min_contribution_amount` | 50 | Min monthly contribution (ZMW) |
| `max_members_per_group` | 50 | Max members per group |
| `withdrawal_expiry_hours` | 72 | Hours before withdrawal expires |
| `maintenance_mode` | false | Enable/disable platform |
| `max_groups_per_user` | 5 | Max groups per user |
| `kyc_required` | true | Require KYC verification |

---

## Admin Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/superadmin/admins` | List all admins |
| PATCH | `/superadmin/admins/:userId/role` | Promote/demote user role |

---

## Audit Logs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/superadmin/audit-logs` | Searchable audit trail |

### Query Params
- `action` – e.g. `user_banned`, `payout_disbursed`
- `actorId`, `entityType`
- `startDate`, `endDate`
- `page`, `limit`

---

## Health Check

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/superadmin/health` | Platform health + alert counts |
| GET | `/health` | Public liveness probe |

### Health Response
```json
{
  "status": "healthy",
  "database": { "connected": true },
  "alerts": {
    "pendingPayouts": 3,
    "failedTransactions24h": 0,
    "pendingKycVerifications": 42,
    "expiredWithdrawals": 1
  }
}
```

---

## Standard Response Envelope

### Success
```json
{ "success": true, "data": { ... } }
```

### Paginated
```json
{
  "success": true,
  "data": [...],
  "pagination": {
    "total": 250,
    "page": 1,
    "limit": 20,
    "totalPages": 13
  }
}
```

### Error
```json
{ "success": false, "message": "Description of error" }
```

### Validation Error (422)
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    { "field": "monthlyAmount", "message": "Must be a number greater than 0" }
  ]
}
```
