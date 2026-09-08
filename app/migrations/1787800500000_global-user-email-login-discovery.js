/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.dropConstraint('users', 'users_uniq_tenant_id_email');
  pgm.sql('CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email));');
  pgm.sql(`
    CREATE FUNCTION public.find_tenant_user_for_login(candidate_email text)
    RETURNS TABLE (
      user_id uuid,
      tenant_id uuid,
      role text,
      password_hash text,
      tenant_active boolean,
      tenant_slug text,
      tenant_name text
    )
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT u.id, u.tenant_id, u.role, u.password_hash,
             t.active, t.slug, t.name
      FROM public.users AS u
      JOIN public.tenants AS t ON t.id = u.tenant_id
      WHERE lower(u.email) = lower(candidate_email)
    $function$;

    REVOKE ALL ON FUNCTION public.find_tenant_user_for_login(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.find_tenant_user_for_login(text) TO app_user;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP FUNCTION public.find_tenant_user_for_login(text);');
  pgm.sql('DROP INDEX users_email_lower_unique;');
  pgm.addConstraint('users', 'users_uniq_tenant_id_email', { unique: ['tenant_id', 'email'] });
};
