"""Bring the 3x-baked pose GIFs in line with the 48px native sprite set.

The pose sprites (peek / peek-talk / jump-*) were exported at 144x144, i.e.
3x pixel art. The original four (idle / talk / roast / roast-talk) are 48x48
native and get scaled up by CSS. Mixing the two means any future change to
--randy-size resamples the big ones on a non-integer factor and blurs them.

Downscaling is lossless here: every 3x3 block in the source is a single flat
colour, so we sample one pixel per block.

Floor alignment is deliberately NOT done here: the jump frames have the otter
touching the frame bottom, so shifting them onto the shared floor would clip
his ears at the apex. The script reports each sprite's floor instead, and
content.css nudges each pose with translateY so nothing is ever cropped.

    python3 tools/normalize_sprites.py
"""

import sys
from PIL import Image, ImageSequence

SRC_SCALE = 3
REFERENCE_FLOOR = 2        # bottom margin of idle/talk/roast at 48px
POSES = ["peek.gif", "peek-talk.gif", "peek-roast.gif",
         "peek-roast-talk.gif", "jump-in.gif", "jump-out.gif"]
ASSETS = "src/assets"


def load(path):
    """-> (frames as RGBA at 1x, durations ms)"""
    frames, durations = [], []
    for fr in ImageSequence.Iterator(Image.open(path)):
        durations.append(fr.info.get("duration") or 100)
        big = fr.convert("RGBA")
        w, h = big.size
        small = Image.new("RGBA", (w // SRC_SCALE, h // SRC_SCALE))
        sp, bp = small.load(), big.load()
        for y in range(small.height):
            for x in range(small.width):
                sp[x, y] = bp[x * SRC_SCALE, y * SRC_SCALE]
        frames.append(small)
    return frames, durations


def bottom_margin(frames):
    """Smallest gap between the lowest opaque pixel and the frame bottom."""
    out = []
    for f in frames:
        px = f.load()
        ys = [y for y in range(f.height) if any(px[x, y][3] for x in range(f.width))]
        out.append(f.height - 1 - max(ys))
    return min(out)


def save_gif(frames, durations, path):
    """Shared palette, index 0 transparent, disposal 2 — same as the originals."""
    colors = sorted({px[:3] for f in frames for px in f.get_flattened_data() if px[3]})
    if len(colors) > 255:
        sys.exit(f"{path}: {len(colors)} colours exceeds the GIF palette")
    idx = {c: i + 1 for i, c in enumerate(colors)}
    pal = [0, 0, 0] + [v for c in colors for v in c]
    pal += [0] * (768 - len(pal))
    out = []
    for f in frames:
        p = Image.new("P", f.size)
        p.putpalette(pal)
        p.putdata([idx[px[:3]] if px[3] else 0 for px in f.get_flattened_data()])
        out.append(p)
    out[0].save(path, save_all=True, append_images=out[1:], duration=durations,
                loop=0, transparency=0, disposal=2, optimize=False)
    return len(colors)


def main():
    for name in POSES:
        path = f"{ASSETS}/{name}"
        frames, durations = load(path)
        bm = bottom_margin(frames)
        n = save_gif(frames, durations, path)
        nudge = REFERENCE_FLOOR - bm
        print(f"{name:15} -> {frames[0].size[0]}x{frames[0].size[1]}  "
              f"{len(frames)} frames  {n} colours  {sum(durations)}ms  "
              f"floor={bm}  css translateY nudge = {-nudge:+d} units")


if __name__ == "__main__":
    main()
