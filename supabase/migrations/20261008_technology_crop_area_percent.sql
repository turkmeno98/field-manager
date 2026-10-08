-- R-Z is the share of a crop's total area covered by a template operation.
-- It is not a field-level percentage or a planned hectare value.
BEGIN;

ALTER TABLE public.technology_operations
  ADD COLUMN crop_area_percent numeric NOT NULL DEFAULT 100;

ALTER TABLE public.technology_operations
  ADD CONSTRAINT technology_operations_crop_area_percent_check
  CHECK (crop_area_percent >= 0 AND crop_area_percent <= 100);

COMMIT;

