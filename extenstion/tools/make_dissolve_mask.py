"""Generate the menu's random-order pixel-dissolve mask frames.

Emits a CSS @keyframes block with the frames inlined as base64 PNGs, for
pasting into src/content/menu.css. They have to be inlined: CSS files in an
extension can't url() an extension asset (see the note atop content.css).

Frame k reveals k/FRAMES of the cells, chosen in a seeded random order, so
each frame is a superset of the last and the sequence is reproducible.

    python3 tools/make_dissolve_mask.py > /tmp/dissolve.css
"""

import base64
import io
import random

import argparse

# Defaults build the collapse/expand arrow's mask. Pass --width/--height/
# --cell/--frames/--name to generate one for anything else.
DEFAULTS = dict(width=20, height=20, cell=4, frames=6, name="randy-arrow-dissolve")
SEED = 20260919           # change for a different scatter

from PIL import Image


def frames(WIDTH, HEIGHT, CELL, FRAMES):
    """Yield (revealed_cell_count, png_bytes) for frames 0..FRAMES-1."""
    cols, rows = WIDTH // CELL, HEIGHT // CELL
    cells = [(c, r) for r in range(rows) for c in range(cols)]
    random.Random(SEED).shuffle(cells)

    for k in range(FRAMES):
        # Luminance stays 255; the alpha channel is what a PNG mask reads.
        img = Image.new("LA", (WIDTH, HEIGHT), (255, 0))
        shown = cells[: round(len(cells) * k / FRAMES)]
        for c, r in shown:
            img.paste((255, 255), (c * CELL, r * CELL, (c + 1) * CELL, (r + 1) * CELL))
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        yield len(shown), buf.getvalue()


def main():
    ap = argparse.ArgumentParser(description="Generate a pixel-dissolve @keyframes block.")
    for k, v in DEFAULTS.items():
        ap.add_argument(f"--{k}", type=type(v), default=v)
    a = ap.parse_args()
    WIDTH, HEIGHT, CELL, FRAMES = a.width, a.height, a.cell, a.frames

    print(f"@keyframes {a.name} {{")
    for k, (shown, png) in enumerate(frames(WIDTH, HEIGHT, CELL, FRAMES)):
        uri = "data:image/png;base64," + base64.b64encode(png).decode()
        pct = k * 100 / FRAMES
        print(f"    /* {shown} of {(WIDTH//CELL)*(HEIGHT//CELL)} cells */")
        print(f"    {pct:g}% {{")
        print(f'        -webkit-mask-image: url("{uri}");')
        print(f'        mask-image: url("{uri}");')
        print("    }")
    print("    100% {")
    print("        -webkit-mask-image: none;")
    print("        mask-image: none;")
    print("    }")
    print("}")


if __name__ == "__main__":
    main()
