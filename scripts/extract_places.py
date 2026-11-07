#!/usr/bin/env python3
"""Extract named places for a preset: things to do, plus a gazetteer of
neighbourhoods, stations and landmarks for searching starting points without
a network connection.

Usage:
    python3 scripts/extract_places.py kanto.osm.pbf tokyo -o build/tokyo-places-osm.json

scripts/build-places.mjs then classifies and compacts the output.
"""

import argparse
import json
import os
import sys

import osmium

HERE = os.path.dirname(os.path.abspath(__file__))

KEEP_TAGS = (
    "name", "name:en", "name:ja-Latn", "name:ja_rm", "amenity", "shop", "tourism", "leisure",
    "historic", "natural", "sport", "cuisine", "religion", "wikidata", "wikipedia", "website",
    "contact:website", "opening_hours", "place", "railway", "public_transport", "station", "aeroway",
)
INTERESTING = ("amenity", "shop", "tourism", "leisure", "historic", "natural", "sport", "place", "railway",
               "public_transport", "aeroway", "wikidata")


def wanted(tags):
    if "name" not in tags:
        return False
    return any(k in tags for k in INTERESTING)


def slim(tags):
    return {k: tags[k] for k in KEEP_TAGS if k in tags}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pbf")
    ap.add_argument("preset")
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args()
    with open(os.path.join(HERE, "presets.json"), encoding="utf-8") as f:
        w, s, e, n = json.load(f)[args.preset]["bbox"]

    def inside(lat, lon):
        return s <= lat <= n and w <= lon <= e

    els = []
    fp = osmium.FileProcessor(args.pbf).with_locations()
    for o in fp:
        if o.is_node():
            if not wanted(o.tags) or not inside(o.location.lat, o.location.lon):
                continue
            els.append({"type": "node", "id": o.id, "lat": round(o.location.lat, 6), "lon": round(o.location.lon, 6),
                        "tags": slim(o.tags)})
        elif o.is_way():
            if not wanted(o.tags):
                continue
            pts = [(nd.location.lat, nd.location.lon) for nd in o.nodes if nd.location.valid()]
            if not pts:
                continue
            lats = [p[0] for p in pts]
            lons = [p[1] for p in pts]
            lat = (min(lats) + max(lats)) / 2
            lon = (min(lons) + max(lons)) / 2
            if not inside(lat, lon):
                continue
            els.append({"type": "way", "id": o.id,
                        "bounds": {"minlat": min(lats), "maxlat": max(lats), "minlon": min(lons), "maxlon": max(lons)},
                        "tags": slim(o.tags)})
    # Landmarks such as Tokyo Tower are often relations (multi-part buildings):
    # assemble their areas and use the centre of their bounds.
    factory = osmium.geom.WKBFactory()
    from shapely import wkb as shapely_wkb
    fp = osmium.FileProcessor(args.pbf).with_areas(osmium.filter.KeyFilter("name"))
    for o in fp:
        if not o.is_area() or o.from_way() or not wanted(o.tags):
            continue
        try:
            geom = shapely_wkb.loads(factory.create_multipolygon(o), hex=True)
        except Exception:
            continue
        minlon, minlat, maxlon, maxlat = geom.bounds
        lat = (minlat + maxlat) / 2
        lon = (minlon + maxlon) / 2
        if not inside(lat, lon):
            continue
        els.append({"type": "relation", "id": o.orig_id(),
                    "bounds": {"minlat": minlat, "maxlat": maxlat, "minlon": minlon, "maxlon": maxlon},
                    "tags": slim(o.tags)})

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"elements": els}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(els)} named places", file=sys.stderr)


if __name__ == "__main__":
    main()
