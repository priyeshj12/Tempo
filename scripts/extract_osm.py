#!/usr/bin/env python3
"""Extract a road network and a city outline from an OpenStreetMap PBF file.

The output is an Overpass-style JSON file ({"elements": [...]}) plus the city
boundary and a land-hugging outline, which scripts/build-preset.mjs turns into
the compact binary graph the web app loads.

Usage:
    pip install osmium shapely
    python3 scripts/extract_osm.py kanto.osm.pbf tokyo -o build/tokyo-osm.json

PBF extracts are available from https://download.openstreetmap.fr/extracts/
or https://download.geofabrik.de/.
"""

import argparse
import json
import math
import os
import sys

import osmium
import shapely
from shapely import wkb as shapely_wkb
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import transform, unary_union

HERE = os.path.dirname(os.path.abspath(__file__))

# Keep in sync with ROAD_CLASSES in src/osm.js.
ROAD_CLASSES = {
    "all": [
        "trunk", "primary", "secondary", "tertiary", "unclassified",
        "residential", "living_street",
        "trunk_link", "primary_link", "secondary_link", "tertiary_link",
    ],
    "main": [
        "trunk", "primary", "secondary", "tertiary", "unclassified",
        "trunk_link", "primary_link", "secondary_link", "tertiary_link",
    ],
    "major": [
        "trunk", "primary", "secondary",
        "trunk_link", "primary_link", "secondary_link",
    ],
}


def local_projection(lon0, lat0):
    """Equirectangular projection in metres around (lon0, lat0)."""
    r = 6371008.8
    kx = r * math.cos(math.radians(lat0)) * math.pi / 180
    ky = r * math.pi / 180

    def fwd(x, y, z=None):
        return ((x - lon0) * kx, (y - lat0) * ky)

    def inv(x, y, z=None):
        return (x / kx + lon0, y / ky + lat0)

    return fwd, inv


def load_boundary(pbf, preset):
    spec = preset["boundary"]
    names = set(spec["names"])
    w, s, e, n = preset["bbox"]
    factory = osmium.geom.WKBFactory()
    parts = {}

    fp = osmium.FileProcessor(pbf).with_areas(
        osmium.filter.TagFilter(("boundary", "administrative"))
    )
    for obj in fp:
        if not obj.is_area():
            continue
        if obj.tags.get("admin_level") != spec["admin_level"]:
            continue
        name = obj.tags.get("name")
        if name not in names:
            continue
        try:
            geom = shapely_wkb.loads(factory.create_multipolygon(obj), hex=True)
        except Exception as exc:  # broken multipolygon
            print(f"  skip {name}: {exc}", file=sys.stderr)
            continue
        c = geom.representative_point()
        if not (w <= c.x <= e and s <= c.y <= n):
            continue  # same ward name in another city
        parts.setdefault(name, []).append(geom)

    missing = names - set(parts)
    if missing:
        print(f"  warning: boundary parts not found: {sorted(missing)}", file=sys.stderr)
    print(f"  boundary parts: {len(parts)}/{len(names)}", file=sys.stderr)
    return unary_union([g for geoms in parts.values() for g in geoms])


def load_roads(pbf, preset, classes):
    w, s, e, n = preset["bbox"]
    wanted = set(classes)
    nodes = {}
    ways = []

    fp = (
        osmium.FileProcessor(pbf)
        .with_locations()
        .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
        .with_filter(osmium.filter.KeyFilter("highway"))
    )
    for way in fp:
        if way.tags.get("highway") not in wanted:
            continue
        if way.tags.get("area") == "yes":
            continue
        refs = []
        inside = False
        for nd in way.nodes:
            loc = nd.location
            if not loc.valid():
                refs = None
                break
            lon, lat = loc.lon, loc.lat
            if w <= lon <= e and s <= lat <= n:
                inside = True
            refs.append((nd.ref, lon, lat))
        if not refs or not inside:
            continue
        ids = []
        for ref, lon, lat in refs:
            nodes[ref] = (round(lon, 7), round(lat, 7))
            ids.append(ref)
        ways.append(ids)

    print(f"  roads: {len(ways)} ways, {len(nodes)} nodes", file=sys.stderr)
    return nodes, ways


def land_outline(boundary, nodes, fwd, inv, cell=120.0):
    """Boundary clipped to where roads actually are, so the outline follows the
    shore instead of the administrative line out in the bay.

    Roads are rasterised onto a coarse grid and the occupied cells are closed
    morphologically, which is far cheaper than buffering every road line."""
    occupied = set()
    for lon, lat in nodes.values():
        x, y = fwd(lon, lat)
        occupied.add((int(math.floor(x / cell)), int(math.floor(y / cell))))
    cells = shapely.box(
        [i * cell for i, _ in occupied],
        [j * cell for _, j in occupied],
        [(i + 1) * cell for i, _ in occupied],
        [(j + 1) * cell for _, j in occupied],
    )
    blob = shapely.union_all(cells).buffer(200, quad_segs=4).buffer(-200, quad_segs=4)
    admin = transform(fwd, boundary)
    shape = admin.intersection(blob)
    if isinstance(shape, MultiPolygon):
        # drop specks, keep anything bigger than 1 km^2
        shape = MultiPolygon([p for p in shape.geoms if p.area > 1e6])
    shape = shape.simplify(25)
    return transform(inv, shape)


def round_geom(geom):
    def rnd(coords):
        return [[round(x, 5), round(y, 5)] for x, y in coords]

    polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    out = []
    for p in polys:
        if not isinstance(p, Polygon) or p.is_empty:
            continue
        out.append([rnd(p.exterior.coords)] + [rnd(r.coords) for r in p.interiors])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pbf")
    ap.add_argument("preset")
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args()

    with open(os.path.join(HERE, "presets.json"), encoding="utf-8") as f:
        preset = json.load(f)[args.preset]

    print("boundary...", file=sys.stderr)
    boundary = load_boundary(args.pbf, preset)
    b = boundary.bounds
    # tighten the road bbox to the boundary
    preset = dict(preset, bbox=[b[0] - 0.002, b[1] - 0.002, b[2] + 0.002, b[3] + 0.002])

    print("roads...", file=sys.stderr)
    nodes, ways = load_roads(args.pbf, preset, ROAD_CLASSES[preset.get("detail", "all")])

    c = boundary.centroid
    fwd, inv = local_projection(c.x, c.y)
    print("outline...", file=sys.stderr)
    outline = land_outline(boundary, nodes, fwd, inv)

    elements = [{"type": "node", "id": i, "lon": lon, "lat": lat} for i, (lon, lat) in nodes.items()]
    elements += [{"type": "way", "id": k, "nodes": ids} for k, ids in enumerate(ways)]

    out = {
        "preset": args.preset,
        "boundary": round_geom(boundary.simplify(0.0001)),
        "outline": round_geom(outline),
        "elements": elements,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
