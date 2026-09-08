/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * Structured postal address, added alongside (not replacing) `location`.
 * Address is the primary tenant-admin-facing input; `location` remains the
 * derived geography column polygon targeting actually queries -- see
 * src/intake/geocoder.js and recipients.js for how the two stay in sync.
 * All columns nullable: a recipient may still have no location at all
 * (group-only targeting), or (advanced/back-compat) coordinates with no
 * address on file.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  pgm.addColumns('recipients', {
    address_line1: { type: 'text' },
    address_line2: { type: 'text' },
    city: { type: 'text' },
    state: { type: 'text' },
    postal_code: { type: 'text' },
    country: { type: 'text' },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropColumns('recipients', ['address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country']);
};
