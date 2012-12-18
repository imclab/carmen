#!/bin/bash
set -e -u

TMP=`mktemp -d tmpXXXX`
createdb -U postgres -T template_postgis $TMP
curl -sfo $TMP/10m-admin-1-states-provinces-shp.zip http://mapbox-geodata.s3.amazonaws.com/natural-earth-1.4.0/cultural/10m-admin-1-states-provinces-shp.zip
unzip -q $TMP/10m-admin-1-states-provinces-shp.zip -d $TMP
ogr2ogr -s_srs EPSG:900913 -t_srs EPSG:4326 -nlt MULTIPOLYGON -nln import -f "PostgreSQL" PG:"host=localhost user=postgres dbname=$TMP" $TMP/10m-admin-1-states-provinces-shp.shp

echo "
CREATE TABLE data(id SERIAL PRIMARY KEY, name VARCHAR, search VARCHAR, lon FLOAT, lat FLOAT, bounds VARCHAR, area FLOAT);
SELECT AddGeometryColumn('public', 'data', 'geometry', 4326, 'MULTIPOLYGON', 2);
INSERT INTO data (id, geometry, name, search) SELECT ogc_fid, st_setsrid(wkb_geometry,4326), name_1 AS name, name_1||','||postal AS search FROM import;
UPDATE data SET lon = st_x(st_pointonsurface(geometry)), lat = st_y(st_pointonsurface(geometry)), bounds = st_xmin(geometry)||','||st_ymin(geometry)||','||st_xmax(geometry)||','||st_ymax(geometry);
UPDATE data SET area = 0;
UPDATE data SET area = st_area(st_geogfromwkb(geometry)) where st_within(geometry,st_geomfromtext('POLYGON((-180 -90, -180 90, 180 90, 180 -90, -180 -90))',4326));
UPDATE data SET lon = -77.0170942, lat = 38.9041485 WHERE id = '885'; -- District of Columbia
" | psql -U postgres $TMP

ogr2ogr -s_srs EPSG:4326 -t_srs EPSG:900913 -f "SQLite" -nln data ne-provinces.sqlite PG:"host=localhost user=postgres dbname=$TMP" data
dropdb -U postgres $TMP
rm -rf $TMP

echo "Written to ne-provinces.sqlite."