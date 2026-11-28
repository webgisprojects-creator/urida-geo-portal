-- Small made-up data for the integration tests. Loaded only into a database whose name ends in "_test".
CREATE EXTENSION IF NOT EXISTS postgis;

DROP TABLE IF EXISTS public.users, public.active_tokens, public.captcha_challenges;
DROP SCHEMA IF EXISTS agra CASCADE;
DROP SCHEMA IF EXISTS ghaziabad CASCADE;

CREATE TABLE public.users (
  id bigserial PRIMARY KEY, username text UNIQUE NOT NULL, email text, password text NOT NULL,
  role text NOT NULL, city text, user_id text, must_change_password boolean DEFAULT false,
  is_active boolean DEFAULT true, deleted_at timestamptz, failed_attempts int DEFAULT 0, lock_until timestamptz
);

CREATE SCHEMA agra;
CREATE SCHEMA ghaziabad;

CREATE TABLE ghaziabad.ghaziabad_road_net (gid int PRIMARY KEY, road_id text, zone_no int, ward_no int, geom geometry(MultiLineString, 4326));
INSERT INTO ghaziabad.ghaziabad_road_net
SELECT i, 'R' || i, 1 + i % 2, 10 + i % 3,
       ST_Multi(ST_MakeLine(ST_SetSRID(ST_MakePoint(77.4 + i * 0.001, 28.6), 4326), ST_SetSRID(ST_MakePoint(77.4 + i * 0.001, 28.601), 4326)))
FROM generate_series(1, 30) i;

CREATE MATERIALIZED VIEW ghaziabad.mv_ghaziabad_street_light AS
  SELECT road_id, zone_no::text AS zone_no, ward_no::text AS ward_no,
         CASE WHEN gid % 3 = 0 THEN 'ILLUMINATED' ELSE 'OTHERS' END AS street_light, (gid * 0.1)::numeric AS length_km, geom
  FROM ghaziabad.ghaziabad_road_net;

CREATE TABLE ghaziabad.atm_bank (zone_no int, ward_no int);
INSERT INTO ghaziabad.atm_bank VALUES (1, 10), (1, 11), (2, 10);

-- same shape as the published view: one row per encroached road, zone totals repeated, no percentage column
CREATE MATERIALIZED VIEW agra.mv_agra_encroachment_summary AS
  SELECT * FROM (VALUES ('R1', '1', 8, 2), ('R2', '1', 8, 2), (NULL, '2', 5, 0)) v(road_id, zone_no, total_roads, encroached_roads);
CREATE TABLE agra.agra_road_net (road_id text, zone_no text, ownership text, row_apr numeric, row_meter numeric, geom geometry(MultiLineString, 4326));
