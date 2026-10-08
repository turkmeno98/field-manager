-- Stage 2: farm-scoped cultivation technology templates.
-- These records are normative templates, not actual field work in field_operations.
-- No seed data is included until the source technology chart and target farm are verified.
BEGIN;

CREATE TABLE public.cultivation_technologies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  crop_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  year integer,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Reuse the existing UNIQUE (id, farm_id) key on crops. No changes to crops
  -- are needed, and the composite FK prevents cross-farm crop references.
  CONSTRAINT cultivation_technologies_crop_farm_fk FOREIGN KEY (crop_id, farm_id)
    REFERENCES public.crops(id, farm_id) ON DELETE RESTRICT,
  CONSTRAINT cultivation_technologies_name_nonempty CHECK (length(btrim(name)) > 0),
  CONSTRAINT cultivation_technologies_year_range CHECK (year IS NULL OR year BETWEEN 1900 AND 2200)
);

-- A NULL year means a reusable, year-independent template. PostgreSQL unique
-- constraints treat NULL values as distinct, so keep the two cases explicit.
CREATE UNIQUE INDEX cultivation_technologies_farm_crop_name_year_uidx
  ON public.cultivation_technologies (farm_id, crop_id, lower(btrim(name)), year)
  WHERE year IS NOT NULL;
CREATE UNIQUE INDEX cultivation_technologies_farm_crop_name_no_year_uidx
  ON public.cultivation_technologies (farm_id, crop_id, lower(btrim(name)))
  WHERE year IS NULL;
CREATE INDEX cultivation_technologies_farm_year_idx
  ON public.cultivation_technologies (farm_id, year, crop_id);
CREATE INDEX cultivation_technologies_crop_farm_idx
  ON public.cultivation_technologies (crop_id, farm_id);

CREATE TABLE public.technology_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  technology_id uuid NOT NULL
    REFERENCES public.cultivation_technologies(id) ON DELETE CASCADE,
  -- Decimal numbers (e.g. 2.8) preserve the source chart's operation numbering.
  operation_no numeric(8, 3) NOT NULL,
  name text NOT NULL,
  stage text,
  timing_type text,
  timing_value text,
  application_method text,
  working_solution_rate numeric,
  working_solution_unit text,
  condition_text text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT technology_operations_no_positive CHECK (operation_no > 0),
  CONSTRAINT technology_operations_name_nonempty CHECK (length(btrim(name)) > 0),
  CONSTRAINT technology_operations_timing_type_check
    CHECK (timing_type IS NULL OR timing_type IN ('phase', 'days_after_operation', 'date', 'condition', 'free_text')),
  CONSTRAINT technology_operations_solution_rate_nonnegative
    CHECK (working_solution_rate IS NULL OR working_solution_rate >= 0),
  CONSTRAINT technology_operations_technology_no_key UNIQUE (technology_id, operation_no)
);
CREATE INDEX technology_operations_technology_order_idx
  ON public.technology_operations (technology_id, operation_no);

CREATE TABLE public.technology_operation_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  technology_operation_id uuid NOT NULL
    REFERENCES public.technology_operations(id) ON DELETE CASCADE,
  product_name text NOT NULL,
  rate numeric,
  rate_unit text,
  sequence_no integer NOT NULL DEFAULT 1,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT technology_operation_products_name_nonempty CHECK (length(btrim(product_name)) > 0),
  CONSTRAINT technology_operation_products_rate_nonnegative CHECK (rate IS NULL OR rate >= 0),
  CONSTRAINT technology_operation_products_sequence_positive CHECK (sequence_no > 0),
  CONSTRAINT technology_operation_products_operation_sequence_key UNIQUE (technology_operation_id, sequence_no)
);
CREATE INDEX technology_operation_products_operation_order_idx
  ON public.technology_operation_products (technology_operation_id, sequence_no);

CREATE OR REPLACE FUNCTION private.touch_cultivation_technology_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER cultivation_technologies_touch_updated_at
  BEFORE UPDATE ON public.cultivation_technologies
  FOR EACH ROW EXECUTE FUNCTION private.touch_cultivation_technology_updated_at();
CREATE TRIGGER technology_operations_touch_updated_at
  BEFORE UPDATE ON public.technology_operations
  FOR EACH ROW EXECUTE FUNCTION private.touch_cultivation_technology_updated_at();
CREATE TRIGGER technology_operation_products_touch_updated_at
  BEFORE UPDATE ON public.technology_operation_products
  FOR EACH ROW EXECUTE FUNCTION private.touch_cultivation_technology_updated_at();

ALTER TABLE public.cultivation_technologies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.technology_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.technology_operation_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY cultivation_technologies_select_member
  ON public.cultivation_technologies FOR SELECT TO authenticated
  USING (private.user_has_farm_role(farm_id));

CREATE POLICY cultivation_technologies_insert_agronomy
  ON public.cultivation_technologies FOR INSERT TO authenticated
  WITH CHECK (
    private.user_has_farm_role(farm_id, ARRAY['agronomist', 'manager', 'owner'])
    AND EXISTS (
      SELECT 1 FROM public.crops AS c
      WHERE c.id = cultivation_technologies.crop_id
        AND c.farm_id = cultivation_technologies.farm_id
    )
  );

CREATE POLICY cultivation_technologies_update_agronomy
  ON public.cultivation_technologies FOR UPDATE TO authenticated
  USING (private.user_has_farm_role(farm_id, ARRAY['agronomist', 'manager', 'owner']))
  WITH CHECK (
    private.user_has_farm_role(farm_id, ARRAY['agronomist', 'manager', 'owner'])
    AND EXISTS (
      SELECT 1 FROM public.crops AS c
      WHERE c.id = cultivation_technologies.crop_id
        AND c.farm_id = cultivation_technologies.farm_id
    )
  );

CREATE POLICY cultivation_technologies_delete_manager
  ON public.cultivation_technologies FOR DELETE TO authenticated
  USING (private.user_has_farm_role(farm_id, ARRAY['manager', 'owner']));

CREATE POLICY technology_operations_select_member
  ON public.technology_operations FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.cultivation_technologies AS t
      WHERE t.id = technology_operations.technology_id
        AND private.user_has_farm_role(t.farm_id)
    )
  );

CREATE POLICY technology_operations_insert_agronomy
  ON public.technology_operations FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.cultivation_technologies AS t
      WHERE t.id = technology_operations.technology_id
        AND private.user_has_farm_role(t.farm_id, ARRAY['agronomist', 'manager', 'owner'])
    )
  );

CREATE POLICY technology_operations_update_agronomy
  ON public.technology_operations FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.cultivation_technologies AS t
      WHERE t.id = technology_operations.technology_id
        AND private.user_has_farm_role(t.farm_id, ARRAY['agronomist', 'manager', 'owner'])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.cultivation_technologies AS t
      WHERE t.id = technology_operations.technology_id
        AND private.user_has_farm_role(t.farm_id, ARRAY['agronomist', 'manager', 'owner'])
    )
  );

CREATE POLICY technology_operations_delete_manager
  ON public.technology_operations FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.cultivation_technologies AS t
      WHERE t.id = technology_operations.technology_id
        AND private.user_has_farm_role(t.farm_id, ARRAY['manager', 'owner'])
    )
  );

CREATE POLICY technology_operation_products_select_member
  ON public.technology_operation_products FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.technology_operations AS op
      JOIN public.cultivation_technologies AS t ON t.id = op.technology_id
      WHERE op.id = technology_operation_products.technology_operation_id
        AND private.user_has_farm_role(t.farm_id)
    )
  );

CREATE POLICY technology_operation_products_insert_agronomy
  ON public.technology_operation_products FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.technology_operations AS op
      JOIN public.cultivation_technologies AS t ON t.id = op.technology_id
      WHERE op.id = technology_operation_products.technology_operation_id
        AND private.user_has_farm_role(t.farm_id, ARRAY['agronomist', 'manager', 'owner'])
    )
  );

CREATE POLICY technology_operation_products_update_agronomy
  ON public.technology_operation_products FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.technology_operations AS op
      JOIN public.cultivation_technologies AS t ON t.id = op.technology_id
      WHERE op.id = technology_operation_products.technology_operation_id
        AND private.user_has_farm_role(t.farm_id, ARRAY['agronomist', 'manager', 'owner'])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.technology_operations AS op
      JOIN public.cultivation_technologies AS t ON t.id = op.technology_id
      WHERE op.id = technology_operation_products.technology_operation_id
        AND private.user_has_farm_role(t.farm_id, ARRAY['agronomist', 'manager', 'owner'])
    )
  );

CREATE POLICY technology_operation_products_delete_manager
  ON public.technology_operation_products FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.technology_operations AS op
      JOIN public.cultivation_technologies AS t ON t.id = op.technology_id
      WHERE op.id = technology_operation_products.technology_operation_id
        AND private.user_has_farm_role(t.farm_id, ARRAY['manager', 'owner'])
    )
  );

REVOKE ALL ON TABLE
  public.cultivation_technologies,
  public.technology_operations,
  public.technology_operation_products
FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.cultivation_technologies,
  public.technology_operations,
  public.technology_operation_products
TO authenticated;

REVOKE ALL ON FUNCTION private.touch_cultivation_technology_updated_at() FROM PUBLIC, anon, authenticated;

COMMIT;

