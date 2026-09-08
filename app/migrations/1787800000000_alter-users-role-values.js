/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // 'admin' is renamed to 'tenant_admin' to disambiguate it from the new,
  // separate platform_admin concept (see create-platform-admins-table),
  // which deliberately does NOT live in this table or under tenant RLS.
  pgm.dropConstraint('users', 'users_role_check');
  pgm.sql("UPDATE users SET role = 'tenant_admin' WHERE role = 'admin'");
  pgm.addConstraint('users', 'users_role_check', {
    check: "role in ('operator','tenant_admin')",
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('users', 'users_role_check');
  pgm.sql("UPDATE users SET role = 'admin' WHERE role = 'tenant_admin'");
  pgm.addConstraint('users', 'users_role_check', {
    check: "role in ('operator','admin')",
  });
};
