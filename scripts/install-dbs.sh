#!/usr/bin/env bash

DIR=`dirname $0`
TILE_DIR=$DIR/../tiles

if [ ! -d "$TILE_DIR" ]; then
    mkdir "$TILE_DIR"
fi

TILES="01-ne.country 02-ne.province 03-tiger.zipcode 04-mb.place"

for NAME in $TILES; do
  if [ ! -f "$TILE_DIR/$NAME.mbtiles" ]; then
    echo "Downloading $NAME..."
    curl -s -o "$TILE_DIR/$NAME.mbtiles" "http://mapbox-carmen.s3.amazonaws.com/dev/$NAME.mbtiles"
  fi
done

