'use strict';

const express = require('express');
const { z } = require('zod');
const { AppError, asyncHandler } = require('./errors');
const { parseUuidParam, longitude, latitude } = require('./schemas');
const { requireRole } = require('./auth');
const { parseCsv } = require('./csv');
const { GeocodeError } = require('./geocoder');

function nameSchema() {
  return z.string().trim().min(1).max(200);
}
function phoneSchema() {
  return z.string().trim().min(1).max(32);
}
function emailSchema() {
  return z.string().trim().email().max(320);
}
function addressLine1Schema() {
  return z.string().trim().min(1).max(200);
}
function addressLine2Schema() {
  return z.string().trim().min(1).max(200);
}
function citySchema() {
  return z.string().trim().min(1).max(120);
}
function stateSchema() {
  return z.string().trim().min(1).max(120);
}
function postalCodeSchema() {
  return z.string().trim().min(1).max(20);
}
function countrySchema() {
  return z.string().trim().min(1).max(60);
}

// A postal address is the primary, user-facing way to give a recipient a
// location -- longitude/latitude remain available as an advanced/manual
// override (e.g. no geocoder configured, or an address can't be resolved),
// but a normal tenant admin should never need to type coordinates.
const ADDRESS_FIELDS = ['addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country'];
const REQUIRED_ADDRESS_FIELDS = ['addressLine1', 'city', 'state', 'postalCode'];

function hasValue(data, key) {
  return data[key] !== undefined && data[key] !== null && data[key] !== '';
}

// Key PRESENCE (not value) -- true the moment any address field is part of
// this request at all, including an explicit null used to clear it. This is
// what distinguishes "the address wasn't touched" (no address keys present)
// from "the address was touched" (keys present, whether set to a real value
// or explicitly cleared) -- the two need different handling below, and
// can't be told apart by value alone.
function addressKeysPresent(data) {
  return ADDRESS_FIELDS.some((key) => key in data);
}

// True once the address has been touched (addressKeysPresent) and every
// field in it is blank -- i.e. an explicit "clear the address" request, as
// opposed to a real (and, per addressCompleteness, necessarily complete)
// address.
function addressAllBlank(data) {
  return ADDRESS_FIELDS.every((key) => !hasValue(data, key));
}

function pairedCoordinates(data, ctx) {
  const hasLongitude = data.longitude !== undefined && data.longitude !== null;
  const hasLatitude = data.latitude !== undefined && data.latitude !== null;
  if (hasLongitude !== hasLatitude) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasLongitude ? 'latitude' : 'longitude'],
      message: 'longitude and latitude must be provided together',
    });
  }
}

// If the address is touched at all, it must end up either completely blank
// (an explicit "clear the address" request -- valid, see resolveLocation)
// or completely filled in for the required subset -- never a partial
// address. An update always re-sends the whole address rather than merging
// a partial diff into whatever's already on the row, so geocoding always
// has a complete address to resolve, and a clear is never mistaken for a
// half-entered address.
function addressCompleteness(data, ctx) {
  if (!addressKeysPresent(data)) return;
  if (addressAllBlank(data)) return;
  for (const key of REQUIRED_ADDRESS_FIELDS) {
    if (!hasValue(data, key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when providing an address` });
    }
  }
}

function locationRefinements(data, ctx) {
  pairedCoordinates(data, ctx);
  addressCompleteness(data, ctx);
}

const addressShape = {
  addressLine1: addressLine1Schema().nullish(),
  addressLine2: addressLine2Schema().nullish(),
  city: citySchema().nullish(),
  state: stateSchema().nullish(),
  postalCode: postalCodeSchema().nullish(),
  country: countrySchema().nullish(),
};

const createRecipientSchema = z.object({
  name: nameSchema(),
  phone: phoneSchema().nullish(),
  email: emailSchema().nullish(),
  ...addressShape,
  longitude: longitude.nullish(),
  latitude: latitude.nullish(),
}).strict().superRefine(locationRefinements);

const updateRecipientSchema = z.object({
  name: nameSchema().optional(),
  phone: phoneSchema().nullish(),
  email: emailSchema().nullish(),
  ...addressShape,
  longitude: longitude.nullish(),
  latitude: latitude.nullish(),
}).strict()
  .refine((data) => Object.keys(data).length > 0, 'At least one field must be provided')
  .superRefine(locationRefinements);

function throwValidation(error) {
  throw AppError.validation(error.issues.map((issue) => ({
    path: issue.path.join('.'), message: issue.message,
  })));
}

function addressFieldsFromInput(input) {
  return {
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2 ?? null,
    city: input.city,
    state: input.state,
    postalCode: input.postalCode,
    country: input.country || 'US',
  };
}

const EMPTY_ADDRESS_FIELDS = {
  addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null,
};

// Resolves what to write for the address + location columns from a
// validated create/update input. Four cases:
//  - explicit longitude/latitude (the manual override): always wins and
//    always skips geocoding, regardless of what the address looks like.
//  - address explicitly cleared (all address fields blank, but touched):
//    wipes both the address text and the derived location, no geocode call.
//  - address untouched entirely (no address keys in the input at all):
//    leaves both address and location alone -- signaled by leaving
//    `longitude`/`latitude` as `undefined` rather than null, since `null`
//    is a real, meaningful write (clear) and `undefined` is "don't touch".
//  - a real, complete address (guaranteed complete by addressCompleteness
//    above): geocoded into the derived location.
async function resolveLocation({ input, geocode }) {
  const hasCoordinates = 'longitude' in input;
  const keysPresent = addressKeysPresent(input);
  const allBlank = keysPresent && addressAllBlank(input);
  const hasCompleteAddress = keysPresent && !allBlank;

  if (hasCoordinates) {
    const addressFields = hasCompleteAddress ? addressFieldsFromInput(input) : (allBlank ? EMPTY_ADDRESS_FIELDS : null);
    return { addressFields, longitude: input.longitude ?? null, latitude: input.latitude ?? null };
  }
  if (allBlank) {
    return { addressFields: EMPTY_ADDRESS_FIELDS, longitude: null, latitude: null };
  }
  if (!hasCompleteAddress) {
    return { addressFields: null, longitude: undefined, latitude: undefined };
  }

  const addressFields = addressFieldsFromInput(input);
  try {
    const geocoded = await geocode(addressFields);
    return { addressFields, longitude: geocoded.longitude, latitude: geocoded.latitude };
  } catch (error) {
    if (error instanceof GeocodeError) {
      throw AppError.validation([{ path: 'address', message: error.message }]);
    }
    throw error;
  }
}

function mapRecipient(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    longitude: row.longitude === null ? null : Number(row.longitude),
    latitude: row.latitude === null ? null : Number(row.latitude),
    active: row.deactivated_at === null,
    createdAt: row.created_at,
  };
}

const SELECT_FIELDS = `
  id, name, phone, email,
  address_line1, address_line2, city, state, postal_code, country,
  ST_X(location::geometry) AS longitude, ST_Y(location::geometry) AS latitude,
  deactivated_at, created_at`;

async function listRecipients({ db, auth, includeInactive }) {
  return db.withTenant(auth.tenantId, async (client) => {
    const result = await client.query(
      `SELECT ${SELECT_FIELDS} FROM recipients
       WHERE tenant_id = $1 ${includeInactive ? '' : 'AND deactivated_at IS NULL'}
       ORDER BY name ASC, id ASC`,
      [auth.tenantId]
    );
    return result.rows.map(mapRecipient);
  });
}

async function createRecipient({ db, auth, input, geocode }) {
  const location = await resolveLocation({ input, geocode });
  return db.withTenant(auth.tenantId, async (client) => {
    const result = await client.query(
      `INSERT INTO recipients (
         tenant_id, name, phone, email,
         address_line1, address_line2, city, state, postal_code, country,
         location
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         CASE WHEN $11::double precision IS NOT NULL
           THEN ST_SetSRID(ST_MakePoint($11, $12), 4326)::geography
           ELSE NULL
         END
       )
       RETURNING ${SELECT_FIELDS}`,
      [
        auth.tenantId, input.name, input.phone ?? null, input.email ?? null,
        location.addressFields?.addressLine1 ?? null, location.addressFields?.addressLine2 ?? null,
        location.addressFields?.city ?? null, location.addressFields?.state ?? null,
        location.addressFields?.postalCode ?? null, location.addressFields?.country ?? null,
        location.longitude ?? null, location.latitude ?? null,
      ]
    );
    return mapRecipient(result.rows[0]);
  });
}

// Builds the UPDATE's SET clause and parameter list from a running
// placeholder counter (starting at 2 -- $1 is always auth.tenantId in the
// query below) rather than back-computing positions from values.length,
// which is what caused a real SQL-placeholder-collision bug here before.
function buildUpdateSet(input, location) {
  const columns = { name: 'name', phone: 'phone', email: 'email' };
  const sets = [];
  const values = [];
  let placeholder = 2;
  for (const [key, column] of Object.entries(columns)) {
    if (key in input) {
      values.push(input[key] ?? null);
      sets.push(`${column} = $${placeholder}`);
      placeholder += 1;
    }
  }
  if (location.addressFields) {
    const addressColumns = {
      addressLine1: 'address_line1', addressLine2: 'address_line2',
      city: 'city', state: 'state', postalCode: 'postal_code', country: 'country',
    };
    for (const [key, column] of Object.entries(addressColumns)) {
      values.push(location.addressFields[key] ?? null);
      sets.push(`${column} = $${placeholder}`);
      placeholder += 1;
    }
  }
  if (location.longitude !== undefined) {
    values.push(location.longitude, location.latitude);
    const longitudePlaceholder = placeholder;
    const latitudePlaceholder = placeholder + 1;
    sets.push(
      `location = CASE WHEN $${longitudePlaceholder}::double precision IS NOT NULL
         THEN ST_SetSRID(ST_MakePoint($${longitudePlaceholder}, $${latitudePlaceholder}), 4326)::geography
         ELSE NULL
       END`
    );
  }
  return { sets, values };
}

async function updateRecipient({ db, auth, recipientId, input, geocode }) {
  // Resolved (including any geocode call) before the UPDATE is built, so a
  // geocoding failure throws here and the query never runs -- the existing
  // recipient's address and location are left completely unchanged.
  const location = await resolveLocation({ input, geocode });
  const { sets, values } = buildUpdateSet(input, location);
  return db.withTenant(auth.tenantId, async (client) => {
    const result = await client.query(
      `UPDATE recipients SET ${sets.join(', ')}
       WHERE tenant_id = $1 AND id = $${values.length + 2}
       RETURNING ${SELECT_FIELDS}`,
      [auth.tenantId, ...values, recipientId]
    );
    if (!result.rows[0]) throw new AppError(404, 'not_found', 'Recipient not found');
    return mapRecipient(result.rows[0]);
  });
}

// Soft delete only -- recipients can be referenced by historical deliveries
// and group_members with no ON DELETE CASCADE. COALESCE preserves the
// original deactivation timestamp if this recipient was already inactive
// (idempotent, not a fresh "re-deactivation").
async function deactivateRecipient({ db, auth, recipientId }) {
  return db.withTenant(auth.tenantId, async (client) => {
    const result = await client.query(
      `UPDATE recipients SET deactivated_at = COALESCE(deactivated_at, now())
       WHERE tenant_id = $1 AND id = $2
       RETURNING ${SELECT_FIELDS}`,
      [auth.tenantId, recipientId]
    );
    if (!result.rows[0]) throw new AppError(404, 'not_found', 'Recipient not found');
    return mapRecipient(result.rows[0]);
  });
}

// --- CSV import/export -----------------------------------------------
// Documented format (README's CSV section): name,email,phone,address_line1,
// address_line2,city,state,postal_code,country,group. Columns may appear in
// any order; header names are matched case-insensitively. `group` is
// optional per row: blank imports the recipient without membership, an
// unknown group name rejects that row (never auto-creates a group -- a typo
// would otherwise silently create a junk group). Frontend-parsed previews
// are never trusted: this is the sole authority, re-parsing the raw CSV
// text server-side.
//
// latitude/longitude columns are still accepted for backwards compatibility
// (and as a manual override, exactly like the CRUD endpoints -- present
// coordinates always skip geocoding for that row, even if an address is
// also given), but address columns are the documented default: rows with a
// complete address are geocoded one at a time through the same injected
// `geocode` the CRUD handlers use, so a batch import respects whatever
// rate limit the configured provider enforces. A geocoding failure fails
// just that row -- see importRecipientsFromCsv -- it never aborts the rest
// of the import.
const CSV_COLUMNS = [
  'name', 'email', 'phone',
  'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country',
  'latitude', 'longitude', 'group',
];
const MAX_CSV_DATA_ROWS = 1_000;
const MAX_CSV_CHARS = 200_000;

const importSchema = z.object({ csv: z.string().min(1).max(MAX_CSV_CHARS) }).strict();

function parseCsvHeader(headerRow) {
  const normalized = headerRow.map((cell) => cell.trim().toLowerCase());
  const unknown = normalized.filter((name) => !CSV_COLUMNS.includes(name));
  if (unknown.length > 0) {
    throw AppError.validation([{ path: 'csv', message: `Unknown column(s): ${unknown.join(', ')}` }]);
  }
  if (!normalized.includes('name')) {
    throw AppError.validation([{ path: 'csv', message: "CSV must include a 'name' column" }]);
  }
  return normalized;
}

function cellsToRecord(header, cells) {
  const record = {};
  header.forEach((column, index) => { record[column] = (cells[index] ?? '').trim(); });
  return record;
}

function validateCsvRow(record, groupIdByName) {
  const errors = [];

  const name = record.name || '';
  if (!name) errors.push('name is required');
  else if (name.length > 200) errors.push('name must be at most 200 characters');

  let email = null;
  if (record.email) {
    const parsed = emailSchema().safeParse(record.email);
    if (!parsed.success) errors.push('email is invalid');
    else email = parsed.data;
  }

  let phone = null;
  if (record.phone) {
    const parsed = phoneSchema().safeParse(record.phone);
    if (!parsed.success) errors.push('phone is invalid');
    else phone = parsed.data;
  }

  let coordLongitude = null;
  let coordLatitude = null;
  const hasLongitude = Boolean(record.longitude);
  const hasLatitude = Boolean(record.latitude);
  if (hasLongitude !== hasLatitude) {
    errors.push('latitude and longitude must be provided together');
  } else if (hasLongitude && hasLatitude) {
    const lonNumber = Number(record.longitude);
    const latNumber = Number(record.latitude);
    if (!Number.isFinite(lonNumber)) errors.push('longitude is not a valid number');
    else if (!longitude.safeParse(lonNumber).success) errors.push('longitude is out of range');
    else coordLongitude = lonNumber;
    if (!Number.isFinite(latNumber)) errors.push('latitude is not a valid number');
    else if (!latitude.safeParse(latNumber).success) errors.push('latitude is out of range');
    else coordLatitude = latNumber;
  }
  const hasCoordinates = hasLongitude && hasLatitude;

  const addressLine1 = record.address_line1 || '';
  const addressLine2 = record.address_line2 || '';
  const city = record.city || '';
  const state = record.state || '';
  const postalCode = record.postal_code || '';
  const country = record.country || '';
  const hasAddress = Boolean(addressLine1 || city || state || postalCode);
  if (hasAddress) {
    if (!addressLine1) errors.push('address_line1 is required when providing an address');
    if (!city) errors.push('city is required when providing an address');
    if (!state) errors.push('state is required when providing an address');
    if (!postalCode) errors.push('postal_code is required when providing an address');
  }

  let groupId = null;
  const groupName = record.group || '';
  if (groupName) {
    const match = groupIdByName.get(groupName.toLowerCase());
    if (!match) errors.push(`Unknown group: '${groupName}'`);
    else groupId = match;
  }

  if (errors.length > 0) return { ok: false, errors };

  const addressFields = hasAddress
    ? { addressLine1, addressLine2: addressLine2 || null, city, state, postalCode, country: country || 'US' }
    : { addressLine1: null, addressLine2: null, city: null, state: null, postalCode: null, country: null };

  return {
    ok: true,
    recipient: {
      name, email, phone, groupId, ...addressFields,
      // Coordinates given directly are resolved already; an address with no
      // coordinates needs a geocode call the caller makes (it's async and
      // rate-limited by the injected geocoder, so it doesn't belong in this
      // synchronous per-row validation step).
      longitude: hasCoordinates ? coordLongitude : null,
      latitude: hasCoordinates ? coordLatitude : null,
      needsGeocode: hasAddress && !hasCoordinates,
    },
  };
}

async function importRecipientsFromCsv({ db, auth, csvText, geocode }) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    throw AppError.validation([{ path: 'csv', message: 'CSV must include a header row' }]);
  }
  const [headerRow, ...dataRows] = rows;
  const header = parseCsvHeader(headerRow);
  if (dataRows.length > MAX_CSV_DATA_ROWS) {
    throw AppError.validation([{ path: 'csv', message: `CSV must contain at most ${MAX_CSV_DATA_ROWS} data rows` }]);
  }

  return db.withTenant(auth.tenantId, async (client) => {
    const groupsResult = await client.query('SELECT id, name FROM groups WHERE tenant_id = $1', [auth.tenantId]);
    const groupIdByName = new Map(groupsResult.rows.map((row) => [row.name.toLowerCase(), row.id]));

    const existingResult = await client.query(
      `SELECT lower(email) AS email, phone FROM recipients WHERE tenant_id = $1 AND deactivated_at IS NULL`,
      [auth.tenantId]
    );
    const existingEmails = new Set(existingResult.rows.filter((row) => row.email).map((row) => row.email));
    const existingPhones = new Set(existingResult.rows.filter((row) => row.phone).map((row) => row.phone));

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    for (let index = 0; index < dataRows.length; index += 1) {
      const rowNumber = index + 2; // 1-based, +1 to account for the header row
      const record = cellsToRecord(header, dataRows[index]);
      const validated = validateCsvRow(record, groupIdByName);
      if (!validated.ok) {
        failed += 1;
        errors.push({ row: rowNumber, message: validated.errors.join('; ') });
        continue;
      }

      const { recipient } = validated;

      // One bad address must not corrupt the rest of the batch: a geocode
      // failure fails only this row and moves on, exactly like any other
      // per-row validation failure above.
      if (recipient.needsGeocode) {
        try {
          const geocoded = await geocode({
            addressLine1: recipient.addressLine1, addressLine2: recipient.addressLine2,
            city: recipient.city, state: recipient.state, postalCode: recipient.postalCode, country: recipient.country,
          });
          recipient.longitude = geocoded.longitude;
          recipient.latitude = geocoded.latitude;
        } catch (error) {
          if (error instanceof GeocodeError) {
            failed += 1;
            errors.push({ row: rowNumber, message: error.message });
            continue;
          }
          throw error;
        }
      }

      const emailKey = recipient.email ? recipient.email.toLowerCase() : null;
      const isDuplicate = emailKey
        ? existingEmails.has(emailKey)
        : Boolean(recipient.phone) && existingPhones.has(recipient.phone);
      if (isDuplicate) {
        skipped += 1;
        continue;
      }

      const inserted = await client.query(
        `INSERT INTO recipients (
           tenant_id, name, phone, email,
           address_line1, address_line2, city, state, postal_code, country,
           location
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           CASE WHEN $11::double precision IS NOT NULL
             THEN ST_SetSRID(ST_MakePoint($11, $12), 4326)::geography
             ELSE NULL
           END
         )
         RETURNING id`,
        [
          auth.tenantId, recipient.name, recipient.phone, recipient.email,
          recipient.addressLine1, recipient.addressLine2, recipient.city, recipient.state,
          recipient.postalCode, recipient.country,
          recipient.longitude, recipient.latitude,
        ]
      );
      const recipientId = inserted.rows[0].id;
      if (recipient.groupId) {
        await client.query(
          'INSERT INTO group_members (group_id, recipient_id, tenant_id) VALUES ($1, $2, $3)',
          [recipient.groupId, recipientId, auth.tenantId]
        );
      }
      imported += 1;
      if (emailKey) existingEmails.add(emailKey);
      if (recipient.phone) existingPhones.add(recipient.phone);
    }

    return { imported, skipped, failed, errors };
  });
}

function csvEscape(value) {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Group membership isn't included: a recipient can belong to multiple
// groups (group_members is many-to-many), and the documented import format
// only supports one group per row, so round-tripping membership through
// this same shape isn't lossless. Kept to the same fields import accepts.
async function exportRecipientsCsv({ db, auth }) {
  const recipients = await listRecipients({ db, auth, includeInactive: true });
  const lines = [
    'name,email,phone,address_line1,address_line2,city,state,postal_code,country,latitude,longitude',
    ...recipients.map((recipient) => [
      recipient.name, recipient.email ?? '', recipient.phone ?? '',
      recipient.addressLine1 ?? '', recipient.addressLine2 ?? '', recipient.city ?? '',
      recipient.state ?? '', recipient.postalCode ?? '', recipient.country ?? '',
      recipient.latitude ?? '', recipient.longitude ?? '',
    ].map(csvEscape).join(',')),
  ];
  return lines.join('\n');
}

function createRecipientsRouter({ db, geocode }) {
  const router = express.Router();
  router.use(requireRole('tenant_admin'));

  router.get('/', asyncHandler(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    res.json(await listRecipients({ db, auth: req.auth, includeInactive }));
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const parsed = createRecipientSchema.safeParse(req.body);
    if (!parsed.success) throwValidation(parsed.error);
    res.status(201).json(await createRecipient({ db, auth: req.auth, input: parsed.data, geocode }));
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const recipientId = parseUuidParam(req.params.id, 'id');
    const parsed = updateRecipientSchema.safeParse(req.body);
    if (!parsed.success) throwValidation(parsed.error);
    res.json(await updateRecipient({ db, auth: req.auth, recipientId, input: parsed.data, geocode }));
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const recipientId = parseUuidParam(req.params.id, 'id');
    res.json(await deactivateRecipient({ db, auth: req.auth, recipientId }));
  }));

  router.post('/import', asyncHandler(async (req, res) => {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) throwValidation(parsed.error);
    res.json(await importRecipientsFromCsv({ db, auth: req.auth, csvText: parsed.data.csv, geocode }));
  }));

  router.get('/export', asyncHandler(async (req, res) => {
    res.type('text/csv').send(await exportRecipientsCsv({ db, auth: req.auth }));
  }));

  return router;
}

module.exports = {
  createRecipientsRouter,
  createRecipient,
  deactivateRecipient,
  exportRecipientsCsv,
  importRecipientsFromCsv,
  listRecipients,
  updateRecipient,
};
