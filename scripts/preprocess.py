#!/usr/bin/env python3
"""
Pre-process the Groundsource parquet file into compact JSON files
for the static web explorer.

Output:
  data/timeline.json        - monthly event counts
  data/heatmap/YYYY.json    - per-year grid-cell counts grouped by month
"""

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
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
HEATMAP_DIR = DATA_DIR / "heatmap"

GRID_RESOLUTION = 0.5  # degrees


def centroid_from_wkb(wkb_bytes: bytes) -> Optional[Tuple[float, float]]:
    """
    Extract a rough centroid from WKB geometry by averaging all coordinate
    pairs found in the binary payload. Avoids the heavyweight shapely
    dependency for this simple operation.

    Falls back to shapely if the fast path fails.
    """
    if not wkb_bytes or len(wkb_bytes) < 5:
        return None
    try:
        coords = _extract_coords_wkb(wkb_bytes)
        if not coords:
            return None
        lon = sum(c[0] for c in coords) / len(coords)
        lat = sum(c[1] for c in coords) / len(coords)
        if -180 <= lon <= 180 and -90 <= lat <= 90:
            return (lat, lon)
        return None
    except Exception:
        return _centroid_shapely(wkb_bytes)


def _extract_coords_wkb(wkb: bytes) -> List[Tuple[float, float]]:
    """Parse WKB and collect all (x, y) coordinate pairs."""
    coords: list[tuple[float, float]] = []
    _parse_wkb_geometry(wkb, 0, coords)
    return coords


def _parse_wkb_geometry(buf: bytes, offset: int, coords: list) -> int:
    if offset + 5 > len(buf):
        return offset
    byte_order = buf[offset]
    fmt = "<" if byte_order == 1 else ">"
    offset += 1
    wkb_type = struct.unpack(f"{fmt}I", buf[offset:offset + 4])[0]
    offset += 4
    geom_type = wkb_type & 0xFF

    if geom_type == 1:  # Point
        x, y = struct.unpack(f"{fmt}dd", buf[offset:offset + 16])
        coords.append((x, y))
        offset += 16
    elif geom_type == 2:  # LineString
        n_points = struct.unpack(f"{fmt}I", buf[offset:offset + 4])[0]
        offset += 4
        for _ in range(n_points):
            x, y = struct.unpack(f"{fmt}dd", buf[offset:offset + 16])
            coords.append((x, y))
            offset += 16
    elif geom_type == 3:  # Polygon
        n_rings = struct.unpack(f"{fmt}I", buf[offset:offset + 4])[0]
        offset += 4
        for _ in range(n_rings):
            n_points = struct.unpack(f"{fmt}I", buf[offset:offset + 4])[0]
            offset += 4
            for _ in range(n_points):
                x, y = struct.unpack(f"{fmt}dd", buf[offset:offset + 16])
                coords.append((x, y))
                offset += 16
    elif geom_type in (4, 5, 6, 7):  # Multi* or GeometryCollection
        n_geoms = struct.unpack(f"{fmt}I", buf[offset:offset + 4])[0]
        offset += 4
        for _ in range(n_geoms):
            offset = _parse_wkb_geometry(buf, offset, coords)
    return offset


def _centroid_shapely(wkb_bytes: bytes) -> Optional[Tuple[float, float]]:
    try:
        from shapely import wkb
        geom = wkb.loads(wkb_bytes)
        c = geom.centroid
        return (c.y, c.x)
    except Exception:
        return None


def snap_to_grid(lat: float, lon: float) -> Tuple[float, float]:
    grid_lat = round(math.floor(lat / GRID_RESOLUTION) * GRID_RESOLUTION + GRID_RESOLUTION / 2, 2)
    grid_lon = round(math.floor(lon / GRID_RESOLUTION) * GRID_RESOLUTION + GRID_RESOLUTION / 2, 2)
    return (grid_lat, grid_lon)


def main():
    if not PARQUET_PATH.exists():
        print(f"Error: parquet file not found at {PARQUET_PATH}", file=sys.stderr)
        sys.exit(1)

    HEATMAP_DIR.mkdir(parents=True, exist_ok=True)

    pf = pq.ParquetFile(str(PARQUET_PATH))
    total_rows = pf.metadata.num_rows
    print(f"Processing {total_rows:,} rows from {pf.metadata.num_row_groups} row groups...")

    # {year_month: count}
    timeline: defaultdict[str, int] = defaultdict(int)
    # {year: {month_str: {(grid_lat, grid_lon): count}}}
    heatmap: defaultdict[str, defaultdict[str, defaultdict[tuple, int]]] = defaultdict(
        lambda: defaultdict(lambda: defaultdict(int))
    )

    processed = 0
    skipped = 0

    for rg_idx in range(pf.metadata.num_row_groups):
        table = pf.read_row_group(rg_idx, columns=["geometry", "start_date"])
        geom_col = table.column("geometry")
        date_col = table.column("start_date")

        for i in range(len(table)):
            raw_geom = geom_col[i].as_py()
            raw_date = date_col[i].as_py()

            if not raw_geom or not raw_date:
                skipped += 1
                continue

            centroid = centroid_from_wkb(raw_geom)
            if centroid is None:
                skipped += 1
                continue

            lat, lon = centroid
            try:
                year = raw_date[:4]
                month = raw_date[5:7]
                year_month = f"{year}-{month}"
            except (IndexError, TypeError):
                skipped += 1
                continue

            grid_lat, grid_lon = snap_to_grid(lat, lon)
            timeline[year_month] += 1
            heatmap[year][month][(grid_lat, grid_lon)] += 1

            processed += 1
            if processed % 500_000 == 0:
                print(f"  ...processed {processed:,} events")

    print(f"Done: {processed:,} events processed, {skipped:,} skipped")

    # Write timeline.json
    sorted_months = sorted(timeline.keys())
    timeline_data = [{"month": m, "count": timeline[m]} for m in sorted_months]
    timeline_path = DATA_DIR / "timeline.json"
    with open(timeline_path, "w") as f:
        json.dump(timeline_data, f, separators=(",", ":"))
    print(f"Written {timeline_path} ({os.path.getsize(timeline_path):,} bytes)")

    # Write heatmap/YYYY.json
    total_heatmap_size = 0
    for year in sorted(heatmap.keys()):
        year_data = {}
        for month in sorted(heatmap[year].keys()):
            cells = heatmap[year][month]
            year_data[month] = [[lat, lon, count] for (lat, lon), count in cells.items()]
        year_path = HEATMAP_DIR / f"{year}.json"
        with open(year_path, "w") as f:
            json.dump(year_data, f, separators=(",", ":"))
        size = os.path.getsize(year_path)
        total_heatmap_size += size
        print(f"Written {year_path} ({size:,} bytes)")

    print(f"\nTotal heatmap data: {total_heatmap_size / 1024 / 1024:.1f} MB")
    print("Pre-processing complete!")


if __name__ == "__main__":
    main()
