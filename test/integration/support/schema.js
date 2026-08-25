'use strict';

async function getColumn(client, table, column) {
  const { rows } = await client.query(
    `SELECT column_name, data_type, udt_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows[0] || null;
}

async function hasForeignKey(client, table, column, referencedTable) {
  const { rows } = await client.query(
    `SELECT tc.constraint_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = 'public'
       AND tc.table_name = $1
       AND kcu.column_name = $2
       AND ccu.table_name = $3`,
    [table, column, referencedTable]
  );
  return rows.length > 0;
}

async function hasUniqueConstraint(client, table, columns) {
  const { rows } = await client.query(
    `SELECT tc.constraint_name, array_agg(kcu.column_name::text ORDER BY kcu.ordinal_position) AS cols
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'UNIQUE'
       AND tc.table_schema = 'public'
       AND tc.table_name = $1
     GROUP BY tc.constraint_name`,
    [table]
  );
  const target = [...columns].sort().join(',');
  return rows.some((row) => [...row.cols].sort().join(',') === target);
}

async function hasPrimaryKey(client, table, columns) {
  const { rows } = await client.query(
    `SELECT array_agg(kcu.column_name::text ORDER BY kcu.ordinal_position) AS cols
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = 'public'
       AND tc.table_name = $1
     GROUP BY tc.constraint_name`,
    [table]
  );
  if (rows.length === 0) return false;
  const target = [...columns].sort().join(',');
  return [...rows[0].cols].sort().join(',') === target;
}

async function checkConstraintContainsAll(client, table, substrings) {
  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = $1::regclass AND contype = 'c'`,
    [table]
  );
  const combined = rows.map((row) => row.def).join(' | ');
  return substrings.every((s) => combined.includes(s));
}

async function hasIndex(client, table, column, method) {
  const { rows } = await client.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    [table]
  );
  return rows.some(
    (row) =>
      row.indexdef.includes(column) &&
      (!method || row.indexdef.toLowerCase().includes(`using ${method}`))
  );
}

async function rlsStatus(client, table) {
  const { rows } = await client.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`,
    [table]
  );
  return rows[0] || { relrowsecurity: false, relforcerowsecurity: false };
}

async function hasPolicy(client, table, policyName) {
  const { rows } = await client.query(
    `SELECT policyname, qual, with_check
     FROM pg_policies
     WHERE schemaname = 'public' AND tablename = $1 AND policyname = $2`,
    [table, policyName]
  );
  return rows[0] || null;
}

module.exports = {
  getColumn,
  hasForeignKey,
  hasUniqueConstraint,
  hasPrimaryKey,
  checkConstraintContainsAll,
  hasIndex,
  rlsStatus,
  hasPolicy,
};
