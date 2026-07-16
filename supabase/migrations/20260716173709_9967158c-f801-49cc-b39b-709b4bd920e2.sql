UPDATE public.truck_capacity_settings
   SET p21_sql = NULL
 WHERE singleton = true
   AND p21_sql IS NOT NULL
   AND (p21_sql LIKE '%WHERE 1 = 0%' OR p21_sql LIKE '%h.route%');