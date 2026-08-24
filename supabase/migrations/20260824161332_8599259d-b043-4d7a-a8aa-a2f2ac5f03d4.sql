DO $$
DECLARE
  v_route_id uuid;
  v_count int;
BEGIN
  SELECT count(*), min(id::text)::uuid INTO v_count, v_route_id
  FROM public.truck_capacity_routes
  WHERE p21_route_code ILIKE '%MSL01%' OR code ILIKE '%MSL01%';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one route matching MSL01, found %', v_count;
  END IF;

  DELETE FROM public.route_stop_sequences WHERE route_id = v_route_id;

  INSERT INTO public.route_stop_sequences (route_id, position, city_norm, state, delivery_dow_label, is_pickup)
  VALUES
    (v_route_id, 1,  'LAUREL',       'MS', 'WED', false),
    (v_route_id, 2,  'HATTIESBURG',  'MS', 'WED', false),
    (v_route_id, 3,  'BILOXI',       'MS', 'WED', false),
    (v_route_id, 4,  'GULFPORT',     'MS', 'WED', false),
    (v_route_id, 5,  'MANDEVILLE',   'LA', 'WED', false),
    (v_route_id, 6,  'BATON ROUGE',  'LA', 'WED', false),
    (v_route_id, 7,  'PORT ALLEN',   'LA', 'WED', false),
    (v_route_id, 8,  'NEW ORLEANS',  'LA', 'WED', false),
    (v_route_id, 9,  'METAIRIE',     'LA', 'WED', false),
    (v_route_id, 10, 'HARAHAN',      'LA', 'WED', false),
    (v_route_id, 11, 'JEFFERSON',    'LA', 'WED', false),
    (v_route_id, 12, 'KENNER',       'LA', 'WED', false),
    (v_route_id, 13, 'CUT OFF',      'LA', 'WED', false),
    (v_route_id, 14, 'BOURG',        'LA', 'WED (Thur)', false),
    (v_route_id, 15, 'HOUMA',        'LA', 'WED (Thur)', false),
    (v_route_id, 16, 'MORGAN CITY',  'LA', 'Thur', false),
    (v_route_id, 17, 'ABBEVILLE',    'LA', 'Thur', false),
    (v_route_id, 18, 'LAFAYETTE',    'LA', 'Thur', false),
    (v_route_id, 19, 'OPELOUSAS',    'LA', 'Thur', false),
    (v_route_id, 20, 'CROWLEY',      'LA', 'Thur', false),
    (v_route_id, 21, 'LAKE CHARLES', 'LA', 'Thur', false),
    (v_route_id, 22, 'SULPHUR',      'LA', 'Thur', false),
    (v_route_id, 23, 'OAKDALE',      'LA', 'Thur', false),
    (v_route_id, 24, 'ALEXANDRIA',   'LA', 'Thur', false),
    (v_route_id, 25, 'MCCOMB',       'MS', 'Thur/FRI', false),
    (v_route_id, 26, 'BROOKHAVEN',   'MS', 'Thur/FRI', false);
END $$;