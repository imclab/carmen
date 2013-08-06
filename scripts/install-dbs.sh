#!/usr/bin/env bash

DIR=`dirname $0`
TILE_DIR=$DIR/../tiles

if [ ! -d "$TILE_DIR" ]; then
    mkdir "$TILE_DIR"
fi

TILES="mb-places ne-countries ne-provinces tiger-zipcodes"

for NAME in $TILES; do
  if [ ! -f "$TILE_DIR/$NAME.mbtiles" ]; then
    echo "Downloading $NAME..."
    curl -s -o "$TILE_DIR/$NAME.mbtiles" "http://mapbox-carmen.s3.amazonaws.com/dev/$NAME.mbtiles"
  fi
done

