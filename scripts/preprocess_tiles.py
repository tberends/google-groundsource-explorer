#!/usr/bin/env python3
"""
Pre-process the Groundsource parquet into 1x1-degree spatial tiles
containing individual events with full geometry for the detail view.

Output:
  data/tiles/<lat>_<lon>.json  - compact event arrays per 1-degree cell
  data/tiles/index.json        - list of available tiles with event counts
"""

import gzip
import json
import math
import os
import struct
import sys
from collections import defaultdict
from pathlib import Path
from typing import List, Optional, Tuple

import pyarrow.parquet as pq

PARQUET_PATH = Path(__file__).resolve().parent.parent / "groundsource_2026.parquet"
TILES_DIR = Path(__file__).resolve().parent.parent / "data" / "tiles"

COORD_PRECISION = 4  # decimal places (~11m accuracy)

# GeoJSON type → compact integer code
TYPE_CODES = {"Point": 1, "MultiPoint": 2, "LineString": 3,
              "Polygon": 4, "MultiPolygon": 5, "GeometryCollection": 6}


# ── Geometry conversion: WKB → compact format via shapely ────────────────

from shapely import wkb as shapely_wkb
from shapely.geometry import mapping

def wkb_to_compact(wkb_bytes):
    """Convert WKB to [type_code, coordinates] preserving full detail."""
    if not wkb_bytes or len(wkb_bytes) < 5:
        return None
    try:
        geom = shapely_wkb.loads(wkb_bytes)
        if geom.is_empty:
            return None
        gj = mapping(geom)
        coords = _round_coords(gj.get("coordinates", []))
        type_code = TYPE_CODES.get(gj["type"], 0)
        return [type_code, coords]
    except Exception:
        return None


def _round_coords(obj):
    if isinstance(obj, (list, tuple)):
        if len(obj) >= 2 and isinstance(obj[0], (int, float)):
            return [round(obj[0], COORD_PRECISION), round(obj[1], COORD_PRECISION)]
        return [_round_coords(item) for item in obj]
    return obj


def centroid_from_wkb(wkb_bytes):
    """Get centroid lat/lon from WKB bytes."""
    try:
        geom = shapely_wkb.loads(wkb_bytes)
        c = geom.centroid
        return (c.y, c.x)
    except Exception:
        return None


def tile_key(lat, lon):
    """Return the 1-degree tile key for a lat/lon pair."""
    return (math.floor(lat), math.floor(lon))


def main():
    if not PARQUET_PATH.exists():
        print(f"Error: parquet file not found at {PARQUET_PATH}", file=sys.stderr)
        sys.exit(1)

    TILES_DIR.mkdir(parents=True, exist_ok=True)

    pf = pq.ParquetFile(str(PARQUET_PATH))
    total_rows = pf.metadata.num_rows
    print(f"Processing {total_rows:,} rows into 1x1-degree tiles...")

    # Collect events per tile: {(lat_floor, lon_floor): [event, ...]}
    tiles = defaultdict(list)
    processed = 0
    skipped = 0

    for rg_idx in range(pf.metadata.num_row_groups):
        print(f"  Reading row group {rg_idx + 1}/{pf.metadata.num_row_groups}...")
        table = pf.read_row_group(rg_idx, columns=["uuid", "area_km2", "geometry", "start_date", "end_date"])
        uuid_col = table.column("uuid")
        area_col = table.column("area_km2")
        geom_col = table.column("geometry")
        sd_col = table.column("start_date")
        ed_col = table.column("end_date")

        for i in range(len(table)):
            raw_geom = geom_col[i].as_py()
            if not raw_geom:
                skipped += 1
                continue

            centroid = centroid_from_wkb(raw_geom)
            if not centroid:
                skipped += 1
                continue
            lat, lon = centroid

            compact_geom = wkb_to_compact(raw_geom)
            if not compact_geom:
                skipped += 1
                continue
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                skipped += 1
                continue

            uid = uuid_col[i].as_py() or ""
            area = area_col[i].as_py()
            sd = sd_col[i].as_py() or ""
            ed = ed_col[i].as_py() or ""

            tk = tile_key(lat, lon)
            # Format: [uuid, start_date, end_date, area_km2, type_code, coordinates]
            tiles[tk].append([
                uid, sd, ed,
                round(area, 2) if area else 0,
                compact_geom[0], compact_geom[1]
            ])

            processed += 1
            if processed % 500_000 == 0:
                print(f"    ...processed {processed:,} events")

    print(f"Done reading: {processed:,} events, {skipped:,} skipped, {len(tiles):,} tiles")

    # Write gzip-compressed tile files
    index = {}
    total_size = 0
    max_size = 0
    max_tile = ""

    for (tlat, tlon), events in sorted(tiles.items()):
        filename = f"{tlat}_{tlon}.json.gz"
        filepath = TILES_DIR / filename
        json_bytes = json.dumps(events, separators=(",", ":")).encode("utf-8")
        with gzip.open(filepath, "wb", compresslevel=9) as f:
            f.write(json_bytes)
        size = os.path.getsize(filepath)
        total_size += size
        if size > max_size:
            max_size = size
            max_tile = filename
        index[f"{tlat}_{tlon}"] = len(events)

    # Write tile index (uncompressed, small file)
    index_path = TILES_DIR / "index.json"
    with open(index_path, "w") as f:
        json.dump(index, f, separators=(",", ":"))

    print(f"\nTile output:")
    print(f"  Tiles: {len(tiles):,}")
    print(f"  Total size: {total_size / 1024 / 1024:.1f} MB")
    print(f"  Largest tile: {max_tile} ({max_size / 1024 / 1024:.1f} MB)")
    print(f"  Index: {os.path.getsize(index_path):,} bytes")
    print("Tile pre-processing complete!")


if __name__ == "__main__":
    main()
