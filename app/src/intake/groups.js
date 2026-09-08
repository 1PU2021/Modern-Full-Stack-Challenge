'use strict';

const express = require('express');
const { z } = require('zod');
const { AppError, asyncHandler } = require('./errors');
const { parseUuidParam } = require('./schemas');
const { requireRole } = require('./auth');

const groupNameSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();
const addMemberSchema = z.object({ recipientId: z.string().uuid() }).strict();

function throwValidation(error) {
  throw AppError.validation(error.issues.map((issue) => ({
    path: issue.path.join('.'), message: issue.message,
  })));
}

async function listGroups({ db, auth }) {
  return db.withTenant(auth.tenantId, async (client) => {
    const result = await client.query(
      `SELECT g.id, g.name, count(gm.recipient_id) AS member_count
       FROM groups AS g
       LEFT JOIN group_members AS gm
         ON gm.group_id = g.id AND gm.tenant_id = g.tenant_id
       WHERE g.tenant_id = $1
       GROUP BY g.id, g.name
       ORDER BY g.name ASC, g.id ASC`,
      [auth.tenantId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      memberCount: Number(row.member_count),
    }));
  });
}

async function createGroup({ db, auth, name }) {
  return db.withTenant(auth.tenantId, async (client) => {
    const result = await client.query(
      'INSERT INTO groups (tenant_id, name) VALUES ($1, $2) RETURNING id, name',
      [auth.tenantId, name]
    );
    return { id: result.rows[0].id, name: result.rows[0].name, memberCount: 0 };
  });
}

async function renameGroup({ db, auth, groupId, name }) {
  return db.withTenant(auth.tenantId, async (client) => {
    const result = await client.query(
      'UPDATE groups SET name = $1 WHERE tenant_id = $2 AND id = $3 RETURNING id, name',
      [name, auth.tenantId, groupId]
    );
    if (!result.rows[0]) throw new AppError(404, 'not_found', 'Group not found');
    return result.rows[0];
  });
}

// Removes the group and its memberships only -- recipients themselves are
// never touched. No alert-targeting constraint needs enforcing here: a
// group's recipients are resolved into concrete deliveries at fanout time
// (see src/fanout/store.js), not re-resolved later, and an alert whose
// target groupId no longer exists simply resolves to zero recipients (the
// same already-tested path as "empty or missing groups complete without
// deliveries").
async function deleteGroup({ db, auth, groupId }) {
  return db.withTenant(auth.tenantId, async (client) => {
    const group = await client.query('SELECT 1 FROM groups WHERE tenant_id = $1 AND id = $2', [auth.tenantId, groupId]);
    if (!group.rows[0]) throw new AppError(404, 'not_found', 'Group not found');
    await client.query('DELETE FROM group_members WHERE tenant_id = $1 AND group_id = $2', [auth.tenantId, groupId]);
    await client.query('DELETE FROM groups WHERE tenant_id = $1 AND id = $2', [auth.tenantId, groupId]);
  });
}

async function getGroupMembers({ db, auth, groupId }) {
  return db.withTenant(auth.tenantId, async (client) => {
    const group = await client.query('SELECT id, name FROM groups WHERE tenant_id = $1 AND id = $2', [auth.tenantId, groupId]);
    if (!group.rows[0]) throw new AppError(404, 'not_found', 'Group not found');
    const members = await client.query(
      `SELECT r.id, r.name, r.email, r.phone, r.deactivated_at
       FROM group_members AS gm
       JOIN recipients AS r ON r.id = gm.recipient_id AND r.tenant_id = gm.tenant_id
       WHERE gm.tenant_id = $1 AND gm.group_id = $2
       ORDER BY r.name ASC, r.id ASC`,
      [auth.tenantId, groupId]
    );
    return {
      group: group.rows[0],
      members: members.rows.map((row) => ({
        id: row.id, name: row.name, email: row.email, phone: row.phone,
        active: row.deactivated_at === null,
      })),
    };
  });
}

// Both the group and the recipient must actually belong to the caller's
// own tenant -- verified explicitly here rather than trusting the FK alone,
// since group_members.recipient_id references recipients(id) globally
// (across all tenants), and its own tenant_id column only proves this ROW
// claims tenant A, not that the group/recipient it points to are also A's.
async function addGroupMember({ db, auth, groupId, recipientId }) {
  return db.withTenant(auth.tenantId, async (client) => {
    const group = await client.query('SELECT 1 FROM groups WHERE tenant_id = $1 AND id = $2', [auth.tenantId, groupId]);
    if (!group.rows[0]) throw new AppError(404, 'not_found', 'Group not found');
    const recipient = await client.query('SELECT 1 FROM recipients WHERE tenant_id = $1 AND id = $2', [auth.tenantId, recipientId]);
    if (!recipient.rows[0]) throw new AppError(404, 'not_found', 'Recipient not found');
    await client.query(
      `INSERT INTO group_members (group_id, recipient_id, tenant_id)
       VALUES ($1, $2, $3) ON CONFLICT (group_id, recipient_id) DO NOTHING`,
      [groupId, recipientId, auth.tenantId]
    );
    return { groupId, recipientId };
  });
}

async function removeGroupMember({ db, auth, groupId, recipientId }) {
  return db.withTenant(auth.tenantId, async (client) => {
    const result = await client.query(
      'DELETE FROM group_members WHERE tenant_id = $1 AND group_id = $2 AND recipient_id = $3',
      [auth.tenantId, groupId, recipientId]
    );
    if (result.rowCount === 0) throw new AppError(404, 'not_found', 'Membership not found');
  });
}

function createGroupsRouter({ db }) {
  const router = express.Router();

  // GET routes stay available to every authenticated tenant role: operators
  // read/use groups to target alerts, only mutations require tenant_admin.
  router.get('/', asyncHandler(async (req, res) => {
    res.json(await listGroups({ db, auth: req.auth }));
  }));

  router.get('/:id/members', asyncHandler(async (req, res) => {
    const groupId = parseUuidParam(req.params.id, 'id');
    res.json(await getGroupMembers({ db, auth: req.auth, groupId }));
  }));

  router.post('/', requireRole('tenant_admin'), asyncHandler(async (req, res) => {
    const parsed = groupNameSchema.safeParse(req.body);
    if (!parsed.success) throwValidation(parsed.error);
    res.status(201).json(await createGroup({ db, auth: req.auth, name: parsed.data.name }));
  }));

  router.patch('/:id', requireRole('tenant_admin'), asyncHandler(async (req, res) => {
    const groupId = parseUuidParam(req.params.id, 'id');
    const parsed = groupNameSchema.safeParse(req.body);
    if (!parsed.success) throwValidation(parsed.error);
    res.json(await renameGroup({ db, auth: req.auth, groupId, name: parsed.data.name }));
  }));

  router.delete('/:id', requireRole('tenant_admin'), asyncHandler(async (req, res) => {
    const groupId = parseUuidParam(req.params.id, 'id');
    await deleteGroup({ db, auth: req.auth, groupId });
    res.status(204).send();
  }));

  router.post('/:id/members', requireRole('tenant_admin'), asyncHandler(async (req, res) => {
    const groupId = parseUuidParam(req.params.id, 'id');
    const parsed = addMemberSchema.safeParse(req.body);
    if (!parsed.success) throwValidation(parsed.error);
    res.status(201).json(await addGroupMember({ db, auth: req.auth, groupId, recipientId: parsed.data.recipientId }));
  }));

  router.delete('/:id/members/:recipientId', requireRole('tenant_admin'), asyncHandler(async (req, res) => {
    const groupId = parseUuidParam(req.params.id, 'id');
    const recipientId = parseUuidParam(req.params.recipientId, 'recipientId');
    await removeGroupMember({ db, auth: req.auth, groupId, recipientId });
    res.status(204).send();
  }));

  return router;
}

module.exports = {
  createGroupsRouter,
  addGroupMember,
  createGroup,
  deleteGroup,
  getGroupMembers,
  listGroups,
  removeGroupMember,
  renameGroup,
};
