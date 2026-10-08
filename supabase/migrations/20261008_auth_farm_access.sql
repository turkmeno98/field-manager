-- Stage 1 multi-tenant access and atomic season creation.
-- Review and execute in the Supabase SQL Editor only after confirming the access cutover.
BEGIN;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE TABLE public.farm_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT farm_members_role_check
    CHECK (role IN ('owner', 'agronomist', 'manager', 'operator', 'viewer')),
  CONSTRAINT farm_members_farm_user_key UNIQUE (farm_id, user_id)
);

CREATE INDEX farm_members_user_id_idx ON public.farm_members (user_id, farm_id);

CREATE OR REPLACE FUNCTION private.user_has_farm_role(
  p_farm_id uuid,
  p_roles text[] DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.farm_members AS fm
    WHERE fm.farm_id = p_farm_id
      AND fm.user_id = auth.uid()
      AND (p_roles IS NULL OR fm.role = ANY (p_roles))
  );
$function$;

CREATE OR REPLACE FUNCTION private.user_can_access_field(
  p_field_id uuid,
  p_roles text[] DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.fields AS f
    WHERE f.id = p_field_id
      AND f.farm_id IS NOT NULL
      AND private.user_has_farm_role(f.farm_id, p_roles)
  );
$function$;

CREATE OR REPLACE FUNCTION private.user_can_access_season(
  p_season_id uuid,
  p_roles text[] DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.field_seasons AS fs
    WHERE fs.id = p_season_id
      AND private.user_can_access_field(fs.field_id, p_roles)
  );
$function$;

CREATE OR REPLACE FUNCTION private.season_crop_refs_match_farm(
  p_season_id uuid,
  p_planned_crop_id uuid,
  p_planned_variety_id uuid,
  p_actual_crop_id uuid,
  p_actual_variety_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.field_seasons AS fs
    JOIN public.fields AS f ON f.id = fs.field_id
    WHERE fs.id = p_season_id
      AND f.farm_id IS NOT NULL
      AND (p_planned_crop_id IS NULL OR EXISTS (
        SELECT 1 FROM public.crops AS c
        WHERE c.id = p_planned_crop_id AND c.farm_id = f.farm_id
      ))
      AND (p_planned_variety_id IS NULL OR EXISTS (
        SELECT 1 FROM public.varieties AS v
        WHERE v.id = p_planned_variety_id
          AND v.farm_id = f.farm_id
          AND v.crop_id = p_planned_crop_id
      ))
      AND (p_actual_crop_id IS NULL OR EXISTS (
        SELECT 1 FROM public.crops AS c
        WHERE c.id = p_actual_crop_id AND c.farm_id = f.farm_id
      ))
      AND (p_actual_variety_id IS NULL OR EXISTS (
        SELECT 1 FROM public.varieties AS v
        WHERE v.id = p_actual_variety_id
          AND v.farm_id = f.farm_id
          AND v.crop_id = p_actual_crop_id
      ))
  );
$function$;

CREATE OR REPLACE FUNCTION public.create_farm_for_current_user(p_name text, p_notes text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_farm_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Требуется вход' USING ERRCODE = '42501';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RAISE EXCEPTION 'Название хозяйства обязательно' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.farms (name, notes)
  VALUES (btrim(p_name), NULLIF(btrim(p_notes), ''))
  RETURNING id INTO v_farm_id;

  INSERT INTO public.farm_members (farm_id, user_id, role)
  VALUES (v_farm_id, v_user_id, 'owner');

  RETURN v_farm_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_field_season(
  p_field_id uuid,
  p_season_year integer,
  p_season_no smallint,
  p_status text,
  p_planned_crop_id uuid,
  p_planned_variety_id uuid,
  p_planned_yield_c_ha numeric,
  p_actual_yield_c_ha numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_farm_id uuid;
  v_season_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Требуется вход' USING ERRCODE = '42501';
  END IF;

  SELECT f.farm_id INTO v_farm_id
  FROM public.fields AS f
  WHERE f.id = p_field_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Поле не найдено' USING ERRCODE = 'P0002';
  END IF;
  IF v_farm_id IS NULL THEN
    RAISE EXCEPTION 'Поле не привязано к хозяйству' USING ERRCODE = '23514';
  END IF;
  IF NOT private.user_has_farm_role(v_farm_id, ARRAY['operator', 'agronomist', 'manager', 'owner']) THEN
    RAISE EXCEPTION 'Недостаточно прав для создания сезона' USING ERRCODE = '42501';
  END IF;
  IF p_season_no IS NULL OR p_season_no < 1 THEN
    RAISE EXCEPTION 'Номер сезона должен быть положительным' USING ERRCODE = '22023';
  END IF;
  IF p_status NOT IN ('planned', 'active', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'Недопустимый статус сезона' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.crops AS c
    WHERE c.id = p_planned_crop_id AND c.farm_id = v_farm_id
  ) THEN
    RAISE EXCEPTION 'Культура не найдена в хозяйстве поля' USING ERRCODE = '23503';
  END IF;
  IF p_planned_variety_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.varieties AS v
    WHERE v.id = p_planned_variety_id
      AND v.crop_id = p_planned_crop_id
      AND v.farm_id = v_farm_id
  ) THEN
    RAISE EXCEPTION 'Сорт не принадлежит выбранной культуре и хозяйству поля' USING ERRCODE = '23503';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.field_seasons AS fs
    WHERE fs.field_id = p_field_id
      AND fs.season_year = p_season_year
      AND fs.season_no = p_season_no
  ) THEN
    RAISE EXCEPTION 'Сезон с таким годом и номером уже существует'
      USING ERRCODE = '23505', CONSTRAINT = 'field_seasons_field_year_no_key';
  END IF;

  INSERT INTO public.field_seasons (field_id, season_year, season_no, status)
  VALUES (p_field_id, p_season_year, p_season_no, p_status)
  RETURNING id INTO v_season_id;

  INSERT INTO public.season_crops (
    season_id, sequence_no, planned_crop_id, planned_variety_id,
    planned_yield_c_ha, actual_yield_c_ha, status
  ) VALUES (
    v_season_id, 1, p_planned_crop_id, p_planned_variety_id,
    p_planned_yield_c_ha, p_actual_yield_c_ha, 'planned'
  );

  RETURN v_season_id;
END;
$function$;

-- The only existing anon policies are the temporary open CRUD policies on fields.
DROP POLICY IF EXISTS "Allow public delete fields" ON public.fields;
DROP POLICY IF EXISTS "Allow public insert fields" ON public.fields;
DROP POLICY IF EXISTS "Allow public read fields" ON public.fields;
DROP POLICY IF EXISTS "Allow public update fields" ON public.fields;

ALTER TABLE public.farms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farm_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.varieties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.season_crops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS farms_select_member ON public.farms;
CREATE POLICY farms_select_member ON public.farms
  FOR SELECT TO authenticated
  USING (private.user_has_farm_role(id));
DROP POLICY IF EXISTS farms_update_manager ON public.farms;
CREATE POLICY farms_update_manager ON public.farms
  FOR UPDATE TO authenticated
  USING (private.user_has_farm_role(id, ARRAY['manager', 'owner']))
  WITH CHECK (private.user_has_farm_role(id, ARRAY['manager', 'owner']));
DROP POLICY IF EXISTS farms_delete_manager ON public.farms;
CREATE POLICY farms_delete_manager ON public.farms
  FOR DELETE TO authenticated
  USING (private.user_has_farm_role(id, ARRAY['manager', 'owner']));

DROP POLICY IF EXISTS farm_members_select_related ON public.farm_members;
CREATE POLICY farm_members_select_related ON public.farm_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR private.user_has_farm_role(farm_id, ARRAY['manager', 'owner']));
DROP POLICY IF EXISTS farm_members_insert_manager ON public.farm_members;
CREATE POLICY farm_members_insert_manager ON public.farm_members
  FOR INSERT TO authenticated
  WITH CHECK (
    private.user_has_farm_role(farm_id, ARRAY['owner'])
    OR (private.user_has_farm_role(farm_id, ARRAY['manager']) AND role IN ('agronomist', 'operator', 'viewer'))
  );
DROP POLICY IF EXISTS farm_members_update_manager ON public.farm_members;
CREATE POLICY farm_members_update_manager ON public.farm_members
  FOR UPDATE TO authenticated
  USING (
    private.user_has_farm_role(farm_id, ARRAY['owner'])
    OR (private.user_has_farm_role(farm_id, ARRAY['manager']) AND role IN ('agronomist', 'operator', 'viewer'))
  )
  WITH CHECK (
    private.user_has_farm_role(farm_id, ARRAY['owner'])
    OR (private.user_has_farm_role(farm_id, ARRAY['manager']) AND role IN ('agronomist', 'operator', 'viewer'))
  );
DROP POLICY IF EXISTS farm_members_delete_manager ON public.farm_members;
CREATE POLICY farm_members_delete_manager ON public.farm_members
  FOR DELETE TO authenticated
  USING (
    private.user_has_farm_role(farm_id, ARRAY['owner'])
    OR (private.user_has_farm_role(farm_id, ARRAY['manager']) AND role <> 'owner')
  );

DROP POLICY IF EXISTS fields_select_member ON public.fields;
CREATE POLICY fields_select_member ON public.fields
  FOR SELECT TO authenticated
  USING (farm_id IS NOT NULL AND private.user_has_farm_role(farm_id));
DROP POLICY IF EXISTS fields_insert_agronomy ON public.fields;
CREATE POLICY fields_insert_agronomy ON public.fields
  FOR INSERT TO authenticated
  WITH CHECK (farm_id IS NOT NULL AND private.user_has_farm_role(farm_id, ARRAY['agronomist', 'manager', 'owner']));
DROP POLICY IF EXISTS fields_update_agronomy ON public.fields;
CREATE POLICY fields_update_agronomy ON public.fields
  FOR UPDATE TO authenticated
  USING (farm_id IS NOT NULL AND private.user_has_farm_role(farm_id, ARRAY['agronomist', 'manager', 'owner']))
  WITH CHECK (farm_id IS NOT NULL AND private.user_has_farm_role(farm_id, ARRAY['agronomist', 'manager', 'owner']));
DROP POLICY IF EXISTS fields_delete_manager ON public.fields;
CREATE POLICY fields_delete_manager ON public.fields
  FOR DELETE TO authenticated
  USING (farm_id IS NOT NULL AND private.user_has_farm_role(farm_id, ARRAY['manager', 'owner']));

DROP POLICY IF EXISTS crops_select_member ON public.crops;
CREATE POLICY crops_select_member ON public.crops
  FOR SELECT TO authenticated USING (private.user_has_farm_role(farm_id));
DROP POLICY IF EXISTS crops_insert_agronomy ON public.crops;
CREATE POLICY crops_insert_agronomy ON public.crops
  FOR INSERT TO authenticated
  WITH CHECK (private.user_has_farm_role(farm_id, ARRAY['agronomist', 'manager', 'owner']));
DROP POLICY IF EXISTS crops_update_agronomy ON public.crops;
CREATE POLICY crops_update_agronomy ON public.crops
  FOR UPDATE TO authenticated
  USING (private.user_has_farm_role(farm_id, ARRAY['agronomist', 'manager', 'owner']))
  WITH CHECK (private.user_has_farm_role(farm_id, ARRAY['agronomist', 'manager', 'owner']));
DROP POLICY IF EXISTS crops_delete_manager ON public.crops;
CREATE POLICY crops_delete_manager ON public.crops
  FOR DELETE TO authenticated USING (private.user_has_farm_role(farm_id, ARRAY['manager', 'owner']));

DROP POLICY IF EXISTS varieties_select_member ON public.varieties;
CREATE POLICY varieties_select_member ON public.varieties
  FOR SELECT TO authenticated USING (private.user_has_farm_role(farm_id));
DROP POLICY IF EXISTS varieties_insert_agronomy ON public.varieties;
CREATE POLICY varieties_insert_agronomy ON public.varieties
  FOR INSERT TO authenticated
  WITH CHECK (
    private.user_has_farm_role(farm_id, ARRAY['agronomist', 'manager', 'owner'])
    AND EXISTS (SELECT 1 FROM public.crops AS c WHERE c.id = public.varieties.crop_id AND c.farm_id = public.varieties.farm_id)
  );
DROP POLICY IF EXISTS varieties_update_agronomy ON public.varieties;
CREATE POLICY varieties_update_agronomy ON public.varieties
  FOR UPDATE TO authenticated
  USING (private.user_has_farm_role(farm_id, ARRAY['agronomist', 'manager', 'owner']))
  WITH CHECK (
    private.user_has_farm_role(farm_id, ARRAY['agronomist', 'manager', 'owner'])
    AND EXISTS (SELECT 1 FROM public.crops AS c WHERE c.id = public.varieties.crop_id AND c.farm_id = public.varieties.farm_id)
  );
DROP POLICY IF EXISTS varieties_delete_manager ON public.varieties;
CREATE POLICY varieties_delete_manager ON public.varieties
  FOR DELETE TO authenticated USING (private.user_has_farm_role(farm_id, ARRAY['manager', 'owner']));

DROP POLICY IF EXISTS field_seasons_select_member ON public.field_seasons;
CREATE POLICY field_seasons_select_member ON public.field_seasons
  FOR SELECT TO authenticated USING (private.user_can_access_field(field_id));
DROP POLICY IF EXISTS field_seasons_insert_operator ON public.field_seasons;
CREATE POLICY field_seasons_insert_operator ON public.field_seasons
  FOR INSERT TO authenticated
  WITH CHECK (private.user_can_access_field(field_id, ARRAY['operator', 'agronomist', 'manager', 'owner']));
DROP POLICY IF EXISTS field_seasons_update_operator ON public.field_seasons;
CREATE POLICY field_seasons_update_operator ON public.field_seasons
  FOR UPDATE TO authenticated
  USING (private.user_can_access_field(field_id, ARRAY['operator', 'agronomist', 'manager', 'owner']))
  WITH CHECK (private.user_can_access_field(field_id, ARRAY['operator', 'agronomist', 'manager', 'owner']));
DROP POLICY IF EXISTS field_seasons_delete_manager ON public.field_seasons;
CREATE POLICY field_seasons_delete_manager ON public.field_seasons
  FOR DELETE TO authenticated USING (private.user_can_access_field(field_id, ARRAY['manager', 'owner']));

DROP POLICY IF EXISTS season_crops_select_member ON public.season_crops;
CREATE POLICY season_crops_select_member ON public.season_crops
  FOR SELECT TO authenticated USING (private.user_can_access_season(season_id));
DROP POLICY IF EXISTS season_crops_insert_operator ON public.season_crops;
CREATE POLICY season_crops_insert_operator ON public.season_crops
  FOR INSERT TO authenticated
  WITH CHECK (
    private.user_can_access_season(season_id, ARRAY['operator', 'agronomist', 'manager', 'owner'])
    AND private.season_crop_refs_match_farm(season_id, planned_crop_id, planned_variety_id, actual_crop_id, actual_variety_id)
  );
DROP POLICY IF EXISTS season_crops_update_operator ON public.season_crops;
CREATE POLICY season_crops_update_operator ON public.season_crops
  FOR UPDATE TO authenticated
  USING (private.user_can_access_season(season_id, ARRAY['operator', 'agronomist', 'manager', 'owner']))
  WITH CHECK (
    private.user_can_access_season(season_id, ARRAY['operator', 'agronomist', 'manager', 'owner'])
    AND private.season_crop_refs_match_farm(season_id, planned_crop_id, planned_variety_id, actual_crop_id, actual_variety_id)
  );
DROP POLICY IF EXISTS season_crops_delete_manager ON public.season_crops;
CREATE POLICY season_crops_delete_manager ON public.season_crops
  FOR DELETE TO authenticated USING (private.user_can_access_season(season_id, ARRAY['manager', 'owner']));

DROP POLICY IF EXISTS field_operations_select_member ON public.field_operations;
CREATE POLICY field_operations_select_member ON public.field_operations
  FOR SELECT TO authenticated USING (private.user_can_access_season(field_season_id));
DROP POLICY IF EXISTS field_operations_insert_operator ON public.field_operations;
CREATE POLICY field_operations_insert_operator ON public.field_operations
  FOR INSERT TO authenticated
  WITH CHECK (private.user_can_access_season(field_season_id, ARRAY['operator', 'agronomist', 'manager', 'owner']));
DROP POLICY IF EXISTS field_operations_update_operator ON public.field_operations;
CREATE POLICY field_operations_update_operator ON public.field_operations
  FOR UPDATE TO authenticated
  USING (private.user_can_access_season(field_season_id, ARRAY['operator', 'agronomist', 'manager', 'owner']))
  WITH CHECK (private.user_can_access_season(field_season_id, ARRAY['operator', 'agronomist', 'manager', 'owner']));
DROP POLICY IF EXISTS field_operations_delete_manager ON public.field_operations;
CREATE POLICY field_operations_delete_manager ON public.field_operations
  FOR DELETE TO authenticated USING (private.user_can_access_season(field_season_id, ARRAY['manager', 'owner']));

DROP POLICY IF EXISTS field_notes_select_member ON public.field_notes;
CREATE POLICY field_notes_select_member ON public.field_notes
  FOR SELECT TO authenticated USING (private.user_can_access_field(field_id));
DROP POLICY IF EXISTS field_notes_insert_operator ON public.field_notes;
CREATE POLICY field_notes_insert_operator ON public.field_notes
  FOR INSERT TO authenticated
  WITH CHECK (private.user_can_access_field(field_id, ARRAY['operator', 'agronomist', 'manager', 'owner']));
DROP POLICY IF EXISTS field_notes_update_operator ON public.field_notes;
CREATE POLICY field_notes_update_operator ON public.field_notes
  FOR UPDATE TO authenticated
  USING (private.user_can_access_field(field_id, ARRAY['operator', 'agronomist', 'manager', 'owner']))
  WITH CHECK (private.user_can_access_field(field_id, ARRAY['operator', 'agronomist', 'manager', 'owner']));
DROP POLICY IF EXISTS field_notes_delete_manager ON public.field_notes;
CREATE POLICY field_notes_delete_manager ON public.field_notes
  FOR DELETE TO authenticated USING (private.user_can_access_field(field_id, ARRAY['manager', 'owner']));

REVOKE ALL PRIVILEGES ON TABLE
  public.farms, public.farm_members, public.fields, public.crops, public.varieties,
  public.field_seasons, public.season_crops, public.field_operations, public.field_notes
FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.farms, public.farm_members, public.fields, public.crops, public.varieties,
  public.field_seasons, public.season_crops, public.field_operations, public.field_notes
TO authenticated;

REVOKE ALL ON FUNCTION private.user_has_farm_role(uuid, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.user_can_access_field(uuid, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.user_can_access_season(uuid, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.season_crop_refs_match_farm(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.user_has_farm_role(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION private.user_can_access_field(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION private.user_can_access_season(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION private.season_crop_refs_match_farm(uuid, uuid, uuid, uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.create_farm_for_current_user(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_farm_for_current_user(text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.create_field_season(uuid, integer, smallint, text, uuid, uuid, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_field_season(uuid, integer, smallint, text, uuid, uuid, numeric, numeric) TO authenticated;

COMMIT;
