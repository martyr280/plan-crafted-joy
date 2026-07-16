UPDATE public.truck_capacity_settings
   SET p21_sql = NULL
 WHERE p21_sql IS NOT NULL
   AND p21_sql ILIKE '%h.required_date%';